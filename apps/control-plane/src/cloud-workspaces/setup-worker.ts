import { randomUUID } from "node:crypto";

import type pg from "pg";

import { audit } from "../audit.js";
import { withSystemTx, type Tx } from "../db.js";
import {
  completeCloudWorkspaceGenerationTransition,
  failCloudWorkspaceGenerationRollback,
  rollbackCloudWorkspaceGenerationTransition,
} from "./generation-transitions.js";
import {
  retireCloudWorkspaceEngineInstances,
  retireCloudWorkspaceRuntimeAccess,
} from "./runtime-access.js";

const MAX_LOG_EXCERPT_BYTES = 256 * 1024;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const SETUP_EXECUTION_ABORTED = Symbol("setup-execution-aborted");

type SetupWorkerLogger = Pick<Console, "info" | "warn" | "error">;

export type CloudWorkspaceSetupExecution = {
  setupRunId: string;
  workspaceId: string;
  organizationId: string;
  /** Internal stable user id used for narrowly scoped setup authority. */
  authority: {
    accountUserId: string;
  };
  generation: number;
  attempt: number;
  executionFence: number;
  provider: {
    name: string;
    resourceId: string;
  };
  image: {
    ref: string;
    sourceCommit: string | null;
  };
  repository: {
    forge: string;
    owner: string;
    name: string;
    revision: string;
    /** Opaque binding only. The executor resolves authorization just in time. */
    githubInstallationId: string | null;
  };
  settings: {
    version: number;
    /** Redacted immutable settings; secret values are resolved out of band. */
    snapshot: Readonly<Record<string, unknown>>;
    sha256: string;
  };
};

export type CloudWorkspaceSetupReadiness = {
  version: 1;
  setupRunId: string;
  workspaceId: string;
  organizationId: string;
  generation: number;
  executionFence: number;
  image: {
    ref: string;
    sourceCommit: string;
  };
  repository: {
    revision: string;
    commit: string;
  };
  settings: {
    version: number;
    sha256: string;
  };
  engine: {
    instanceId: string;
    protocolVersion: number;
    health: "ready";
    durableRecordConnected: true;
  };
};

export type CloudWorkspaceSetupResult = {
  /** Exact helper/engine proof required before the worker publishes `ready`. */
  readiness: CloudWorkspaceSetupReadiness;
  /** Raw bounded excerpt; the worker applies its required sanitizer. */
  logExcerpt?: string;
  logTruncated?: boolean;
};

export interface CloudWorkspaceSetupExecutor {
  /**
   * Execute bounded setup against the already-provisioned provider resource.
   * Implementations must honor `signal` and provider-side command deadlines.
   */
  execute(
    execution: CloudWorkspaceSetupExecution,
    signal: AbortSignal,
  ): Promise<CloudWorkspaceSetupResult>;
}

export class CloudWorkspaceSetupError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CloudWorkspaceSetupError";
  }
}

export type CloudWorkspaceSetupWorkerOptions = {
  pool: pg.Pool;
  executor: CloudWorkspaceSetupExecutor;
  /** Required secret/output redaction boundary before any text reaches SQL. */
  sanitizeLog: (value: string) => string;
  intervalMs: number;
  leaseMs?: number;
  heartbeatMs?: number;
  executionTimeoutMs?: number;
  retryBaseMs?: number;
  maxClaims?: number;
  workerId?: string;
  logger?: SetupWorkerLogger;
  workosEnabled?: boolean;
};

type ClaimedSetup = CloudWorkspaceSetupExecution & {
  claimCount: number;
};

type ClaimDecision =
  | { kind: "none" }
  | { kind: "processed" }
  | { kind: "claimed"; setup: ClaimedSetup };

type SafeSetupFailure = {
  code: string;
  retryable: boolean;
};

function safeInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
}

function safeFence(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Invalid cloud workspace setup execution fence");
  }
  return parsed;
}

function settingsObject(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid cloud workspace settings snapshot");
  }
  return value as Readonly<Record<string, unknown>>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function cloudWorkspaceSetupReadinessMatches(
  execution: CloudWorkspaceSetupExecution,
  readiness: unknown,
): readiness is CloudWorkspaceSetupReadiness {
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)) {
    return false;
  }
  const value = readiness as Partial<CloudWorkspaceSetupReadiness>;
  return (
    value.version === 1 &&
    value.setupRunId === execution.setupRunId &&
    value.workspaceId === execution.workspaceId &&
    value.organizationId === execution.organizationId &&
    value.generation === execution.generation &&
    value.executionFence === execution.executionFence &&
    execution.image.sourceCommit !== null &&
    value.image?.ref === execution.image.ref &&
    value.image.sourceCommit === execution.image.sourceCommit &&
    value.repository?.revision === execution.repository.revision &&
    typeof value.repository.commit === "string" &&
    COMMIT_PATTERN.test(value.repository.commit) &&
    value.settings?.version === execution.settings.version &&
    value.settings.sha256 === execution.settings.sha256 &&
    SHA256_PATTERN.test(value.settings.sha256) &&
    typeof value.engine?.instanceId === "string" &&
    UUID_PATTERN.test(value.engine.instanceId) &&
    Number.isSafeInteger(value.engine.protocolVersion) &&
    (value.engine.protocolVersion ?? 0) > 0 &&
    (value.engine.protocolVersion ?? 0) <= 65_535 &&
    value.engine.health === "ready" &&
    value.engine.durableRecordConnected === true
  );
}

function safeFailure(error: unknown): SafeSetupFailure {
  if (error instanceof CloudWorkspaceSetupError) {
    return {
      code: /^[a-z][a-z0-9_]{0,127}$/.test(error.code)
        ? error.code
        : "setup_executor_failure",
      retryable: error.retryable,
    };
  }
  return { code: "setup_unknown_failure", retryable: true };
}

export function boundedCloudWorkspaceSetupLog(value: string): {
  value: string;
  truncated: boolean;
} {
  const withoutUnsafeControls = value.replace(
    // Preserve tabs/newlines while removing terminal and database controls.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    "",
  );
  const encoded = Buffer.from(withoutUnsafeControls, "utf8");
  if (encoded.length <= MAX_LOG_EXCERPT_BYTES) {
    return { value: withoutUnsafeControls, truncated: false };
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // A UTF-8 scalar spans at most four bytes, so a byte-bounded prefix needs at
  // most three one-byte retreats. This avoids repeatedly rescanning a large
  // multibyte string on the control-plane event loop.
  for (let end = MAX_LOG_EXCERPT_BYTES; end > MAX_LOG_EXCERPT_BYTES - 4; end--) {
    try {
      return {
        value: decoder.decode(encoded.subarray(0, end)),
        truncated: true,
      };
    } catch {
      // The prefix ended inside a multibyte scalar; retreat one byte.
    }
  }
  throw new Error("Unable to bound cloud workspace setup log");
}

function retryDelayMs(claimCount: number, baseMs: number): number {
  return Math.min(
    MAX_RETRY_DELAY_MS,
    baseMs * 2 ** Math.min(Math.max(claimCount - 1, 0), 8),
  );
}

async function revokeSetupExecutionGrants(
  tx: Tx,
  input: { workspaceId: string; organizationId: string; generation: number },
): Promise<number> {
  const result = await tx.query(
    `UPDATE cloud_workspace_endpoint_grants
     SET revoked_at = now()
     WHERE workspace_id = $1 AND org_id = $2 AND generation = $3
       AND purpose IN ('setup', 'repository-read', 'repository-write')
       AND revoked_at IS NULL`,
    [input.workspaceId, input.organizationId, input.generation],
  );
  return result.rowCount ?? 0;
}

export class CloudWorkspaceSetupWorker {
  private readonly pool: pg.Pool;
  private readonly executor: CloudWorkspaceSetupExecutor;
  private readonly sanitizeLog: (value: string) => string;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly executionTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly maxClaims: number;
  private readonly workerId: string;
  private readonly logger: SetupWorkerLogger;
  private readonly workosEnabled: boolean;
  private readonly activeControllers = new Set<AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<void> | null = null;
  private started = false;
  private stopped = false;
  private ticking = false;

  constructor(options: CloudWorkspaceSetupWorkerOptions) {
    this.pool = options.pool;
    this.executor = options.executor;
    this.sanitizeLog = options.sanitizeLog;
    this.intervalMs = options.intervalMs;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.floor(this.leaseMs / 3);
    this.executionTimeoutMs = options.executionTimeoutMs ?? 30 * 60_000;
    this.retryBaseMs = options.retryBaseMs ?? 5_000;
    this.maxClaims = options.maxClaims ?? 5;
    this.workerId = options.workerId ?? `setup:${randomUUID()}`;
    this.logger = options.logger ?? console;
    this.workosEnabled = options.workosEnabled === true;

    safeInteger(this.intervalMs, "intervalMs", 100, 60_000);
    safeInteger(this.leaseMs, "leaseMs", 1_000, 60 * 60_000);
    safeInteger(this.heartbeatMs, "heartbeatMs", 250, this.leaseMs - 1);
    safeInteger(
      this.executionTimeoutMs,
      "executionTimeoutMs",
      1_000,
      24 * 60 * 60_000,
    );
    safeInteger(this.retryBaseMs, "retryBaseMs", 100, MAX_RETRY_DELAY_MS);
    safeInteger(this.maxClaims, "maxClaims", 1, 20);
    if (this.workerId.length < 1 || this.workerId.length > 255) {
      throw new Error("workerId must contain between 1 and 255 characters");
    }
  }

  start(): () => Promise<void> {
    if (this.started || this.stopped) return () => this.stop();
    this.started = true;
    const run = () => {
      if (this.stopped) return;
      const task = this.tick().catch((error) => {
        this.logger.error(
          `[cloud-workspace] setup tick failed: ${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
      });
      this.activeTick = task;
      void task.finally(() => {
        if (this.activeTick === task) this.activeTick = null;
        if (this.stopped) return;
        this.timer = setTimeout(run, this.intervalMs);
        this.timer.unref();
      });
    };
    run();
    return () => this.stop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.activeControllers) controller.abort();
    await this.activeTick;
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      let processed = 0;
      while (!this.stopped && processed < 10 && (await this.runOnce())) {
        processed += 1;
      }
    } finally {
      this.ticking = false;
    }
  }

  private async claim(): Promise<ClaimDecision> {
    return withSystemTx(this.pool, async (tx) => {
      // Lifecycle routes lock workspace → setup run. Preserve that order here
      // so a stop/delete racing a claim cannot deadlock a database replica.
      const candidate = await tx.query<{
        id: string;
        org_id: string;
        owner_user_id: string;
        current_generation: number;
      }>(
        `SELECT cw.id, cw.org_id, cw.owner_user_id, cw.current_generation
         FROM cloud_workspaces cw
         JOIN organizations organization
           ON organization.id = cw.org_id
          AND organization.deleted_at IS NULL
         JOIN teams team
           ON team.id = cw.team_id AND team.org_id = cw.org_id
          AND team.deleted_at IS NULL
         JOIN organization_members om
           ON om.org_id = cw.org_id AND om.user_id = cw.owner_user_id
         JOIN team_members tm
           ON tm.team_id = cw.team_id AND tm.org_id = cw.org_id
          AND tm.user_id = cw.owner_user_id
         JOIN users account
           ON account.id = cw.owner_user_id AND account.deleted_at IS NULL
          AND account.auth_status = 'active'
         JOIN cloud_workspace_provider_bindings pb
           ON pb.workspace_id = cw.id
          AND pb.generation = cw.current_generation
         WHERE cw.desired_state = 'running'
           AND cw.status = 'setting_up'
           AND cw.deleted_at IS NULL
           AND pb.observed_state = 'running'
           AND pb.provider_resource_id IS NOT NULL
           AND cloud_workspace_generation_policy_current(
             cw.id, cw.current_generation, cw.org_id
           )
           AND cloud_workspace_runtime_authority_live(
             cw.id, cw.current_generation, cw.owner_user_id, $1
           )
           AND EXISTS (
             SELECT 1 FROM cloud_workspace_setup_runs sr
             WHERE sr.workspace_id = cw.id
               AND sr.generation = cw.current_generation
               AND (
                 (sr.state = 'queued' AND sr.next_attempt_at <= now())
                 OR (sr.state = 'running' AND sr.lease_expires_at <= now())
               )
           )
         ORDER BY (
           SELECT min(
             CASE WHEN sr.state = 'queued'
                  THEN sr.next_attempt_at ELSE sr.lease_expires_at END
           )
           FROM cloud_workspace_setup_runs sr
           WHERE sr.workspace_id = cw.id
             AND sr.generation = cw.current_generation
             AND (
               (sr.state = 'queued' AND sr.next_attempt_at <= now())
               OR (sr.state = 'running' AND sr.lease_expires_at <= now())
             )
         ), cw.id
         FOR UPDATE OF cw SKIP LOCKED
         LIMIT 1`,
        [this.workosEnabled],
      );
      const workspace = candidate.rows[0];
      if (!workspace) return { kind: "none" };

      const selected = await tx.query<{
        id: string;
        attempt: number;
        state: "queued" | "running";
        claim_count: number;
        execution_fence: string | number;
        provider: string;
        provider_resource_id: string;
        image_ref: string;
        source_commit: string | null;
        spec_version: number;
        repository_forge: string;
        repository_owner: string;
        repository_name: string;
        repository_revision: string;
        github_installation_id: string | null;
        settings_snapshot: unknown;
        settings_snapshot_sha256: Buffer;
      }>(
        `SELECT sr.id, sr.attempt, sr.state, sr.claim_count,
                sr.execution_fence, g.provider, g.image_ref, g.source_commit,
                pb.provider_resource_id,
                ss.spec_version, ss.repository_forge, ss.repository_owner,
                ss.repository_name, ss.repository_revision,
                ss.github_installation_id, ss.settings_snapshot,
                ss.settings_snapshot_sha256
         FROM cloud_workspace_setup_runs sr
         JOIN cloud_workspace_setup_specs ss
           ON ss.workspace_id = sr.workspace_id
          AND ss.generation = sr.generation
          AND ss.org_id = sr.org_id
         JOIN cloud_workspace_generations g
           ON g.workspace_id = sr.workspace_id
          AND g.generation = sr.generation
          AND g.org_id = sr.org_id
         JOIN cloud_workspace_provider_bindings pb
           ON pb.workspace_id = sr.workspace_id
          AND pb.generation = sr.generation
          AND pb.org_id = sr.org_id
         WHERE sr.workspace_id = $1 AND sr.org_id = $2
           AND sr.generation = $3
           AND (
             (sr.state = 'queued' AND sr.next_attempt_at <= now())
             OR (sr.state = 'running' AND sr.lease_expires_at <= now())
           )
         ORDER BY sr.attempt, sr.id
         FOR UPDATE OF sr
         LIMIT 1`,
        [workspace.id, workspace.org_id, workspace.current_generation],
      );
      const row = selected.rows[0];
      if (!row) return { kind: "processed" };

      if (row.claim_count >= this.maxClaims) {
        await revokeSetupExecutionGrants(tx, {
          workspaceId: workspace.id,
          organizationId: workspace.org_id,
          generation: workspace.current_generation,
        });
        await tx.query(
          `UPDATE cloud_workspace_setup_runs
           SET state = 'failed', completed_at = now(), updated_at = now(),
               error_code = 'setup_claims_exhausted', lease_owner = NULL,
               lease_expires_at = NULL
           WHERE id = $1`,
          [row.id],
        );
        const rolledBack = await rollbackCloudWorkspaceGenerationTransition(
          tx,
          {
            workspaceId: workspace.id,
            organizationId: workspace.org_id,
            candidateGeneration: workspace.current_generation,
            errorCode: "setup_claims_exhausted",
            errorMessage: "Cloud workspace setup did not complete",
          },
        );
        if (!rolledBack) {
          await tx.query(
            `UPDATE cloud_workspaces
             SET status = 'failed', version = version + 1,
                 last_error_code = 'setup_claims_exhausted',
                 last_error_message = 'Cloud workspace setup did not complete',
                 updated_at = now()
             WHERE id = $1`,
            [workspace.id],
          );
          await failCloudWorkspaceGenerationRollback(tx, {
            workspaceId: workspace.id,
            organizationId: workspace.org_id,
            sourceGeneration: workspace.current_generation,
            errorCode: "setup_claims_exhausted",
            errorMessage: "Cloud workspace setup did not complete",
          });
          await retireCloudWorkspaceRuntimeAccess(tx, {
            workspaceId: workspace.id,
            organizationId: workspace.org_id,
            generation: workspace.current_generation,
            reason: "setup_failed",
          });
        }
        await audit(
          tx,
          workspace.org_id,
          null,
          "cloud_workspace.setup_failed",
          {
            workspaceId: workspace.id,
            generation: workspace.current_generation,
            setupRunId: row.id,
            attempt: row.attempt,
            errorCode: "setup_claims_exhausted",
          },
        );
        return { kind: "processed" };
      }

      const reclaimed = row.state === "running";
      if (reclaimed) {
        await revokeSetupExecutionGrants(tx, {
          workspaceId: workspace.id,
          organizationId: workspace.org_id,
          generation: workspace.current_generation,
        });
        await retireCloudWorkspaceEngineInstances(tx, {
          workspaceId: workspace.id,
          organizationId: workspace.org_id,
          generation: workspace.current_generation,
        });
      }
      const claimed = await tx.query<{
        claim_count: number;
        execution_fence: string | number;
      }>(
        `UPDATE cloud_workspace_setup_runs
         SET state = 'running', claim_count = claim_count + 1,
             execution_fence = execution_fence + 1, lease_owner = $2,
             lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
             last_heartbeat_at = now(), started_at = coalesce(started_at, now()),
             completed_at = NULL, error_code = NULL, updated_at = now()
         WHERE id = $1
         RETURNING claim_count, execution_fence`,
        [row.id, this.workerId, this.leaseMs],
      );
      const lease = claimed.rows[0]!;
      const executionFence = safeFence(lease.execution_fence);
      await audit(
        tx,
        workspace.org_id,
        null,
        reclaimed
          ? "cloud_workspace.setup_reclaimed"
          : "cloud_workspace.setup_claimed",
        {
          workspaceId: workspace.id,
          generation: workspace.current_generation,
          setupRunId: row.id,
          attempt: row.attempt,
          claimCount: lease.claim_count,
          executionFence,
        },
      );
      return {
        kind: "claimed",
        setup: {
          setupRunId: row.id,
          workspaceId: workspace.id,
          organizationId: workspace.org_id,
          authority: { accountUserId: workspace.owner_user_id },
          generation: workspace.current_generation,
          attempt: row.attempt,
          claimCount: lease.claim_count,
          executionFence,
          provider: {
            name: row.provider,
            resourceId: row.provider_resource_id,
          },
          image: {
            ref: row.image_ref,
            sourceCommit: row.source_commit,
          },
          repository: {
            forge: row.repository_forge,
            owner: row.repository_owner,
            name: row.repository_name,
            revision: row.repository_revision,
            githubInstallationId: row.github_installation_id,
          },
          settings: {
            version: row.spec_version,
            snapshot: settingsObject(row.settings_snapshot),
            sha256: row.settings_snapshot_sha256.toString("hex"),
          },
        },
      };
    });
  }

  private async renewLease(setup: ClaimedSetup): Promise<boolean> {
    return withSystemTx(this.pool, async (tx) => {
      const workspace = await tx.query<{
        current_generation: number;
        desired_state: string;
        status: string;
        provider_resource_id: string | null;
        observed_state: string | null;
        authority_live: boolean;
      }>(
        `SELECT cw.current_generation, cw.desired_state, cw.status,
                pb.provider_resource_id, pb.observed_state,
                EXISTS (
                  SELECT 1
                  FROM organizations organization
                  JOIN teams team
                    ON team.id = cw.team_id
                   AND team.org_id = organization.id
                   AND team.deleted_at IS NULL
                  JOIN organization_members om
                    ON om.org_id = organization.id AND om.user_id = $3
                  JOIN team_members tm
                    ON tm.team_id = team.id AND tm.org_id = organization.id
                   AND tm.user_id = $3
                  JOIN users account
                    ON account.id = $3 AND account.deleted_at IS NULL
                   AND account.auth_status = 'active'
                  WHERE organization.id = cw.org_id
                    AND organization.deleted_at IS NULL
                    AND cloud_workspace_generation_policy_current(
                      cw.id, cw.current_generation, cw.org_id
                    )
                    AND cloud_workspace_runtime_authority_live(
                      cw.id, cw.current_generation, $3, $4
                    )
                ) AS authority_live
         FROM cloud_workspaces cw
         LEFT JOIN cloud_workspace_provider_bindings pb
           ON pb.workspace_id = cw.id
          AND pb.generation = cw.current_generation
         WHERE cw.id = $1 AND cw.org_id = $2
         FOR UPDATE OF cw`,
        [
          setup.workspaceId,
          setup.organizationId,
          setup.authority.accountUserId,
          this.workosEnabled,
        ],
      );
      const row = workspace.rows[0];
      if (
        !row ||
        !row.authority_live ||
        row.current_generation !== setup.generation ||
        row.desired_state !== "running" ||
        row.status !== "setting_up" ||
        row.observed_state !== "running" ||
        row.provider_resource_id !== setup.provider.resourceId
      ) {
        return false;
      }
      const renewed = await tx.query(
        `UPDATE cloud_workspace_setup_runs
         SET lease_expires_at = now() + ($4::bigint * interval '1 millisecond'),
             last_heartbeat_at = now(), updated_at = now()
         WHERE id = $1 AND lease_owner = $2 AND execution_fence = $3
           AND state = 'running' AND lease_expires_at > now()`,
        [setup.setupRunId, this.workerId, setup.executionFence, this.leaseMs],
      );
      return (renewed.rowCount ?? 0) === 1;
    });
  }

  private async recordSuccess(
    setup: ClaimedSetup,
    readiness: CloudWorkspaceSetupReadiness,
    log: { value: string; truncated: boolean },
  ): Promise<boolean> {
    return withSystemTx(this.pool, async (tx) => {
      const workspace = await tx.query<{
        current_generation: number;
        desired_state: string;
        status: string;
        provider_resource_id: string | null;
        observed_state: string | null;
        authority_live: boolean;
      }>(
        `SELECT cw.current_generation, cw.desired_state, cw.status,
                pb.provider_resource_id, pb.observed_state,
                EXISTS (
                  SELECT 1
                  FROM organizations organization
                  JOIN teams team
                    ON team.id = cw.team_id
                   AND team.org_id = organization.id
                   AND team.deleted_at IS NULL
                  JOIN organization_members om
                    ON om.org_id = organization.id AND om.user_id = $3
                  JOIN team_members tm
                    ON tm.team_id = team.id AND tm.org_id = organization.id
                   AND tm.user_id = $3
                  JOIN users account
                    ON account.id = $3 AND account.deleted_at IS NULL
                   AND account.auth_status = 'active'
                  WHERE organization.id = cw.org_id
                    AND organization.deleted_at IS NULL
                    AND cloud_workspace_generation_policy_current(
                      cw.id, cw.current_generation, cw.org_id
                    )
                    AND cloud_workspace_runtime_authority_live(
                      cw.id, cw.current_generation, $3, $4
                    )
                ) AS authority_live
         FROM cloud_workspaces cw
         LEFT JOIN cloud_workspace_provider_bindings pb
           ON pb.workspace_id = cw.id
          AND pb.generation = cw.current_generation
         WHERE cw.id = $1 AND cw.org_id = $2
         FOR UPDATE OF cw`,
        [
          setup.workspaceId,
          setup.organizationId,
          setup.authority.accountUserId,
          this.workosEnabled,
        ],
      );
      const current = workspace.rows[0];
      const owned = await tx.query(
        `SELECT 1 FROM cloud_workspace_setup_runs
         WHERE id = $1 AND lease_owner = $2 AND execution_fence = $3
           AND state = 'running' AND lease_expires_at > now()
         FOR UPDATE`,
        [setup.setupRunId, this.workerId, setup.executionFence],
      );
      if ((owned.rowCount ?? 0) !== 1) return false;

      // Membership/lifecycle retirement locks endpoint grants before engine
      // instances. Lock the exact consumed registration grant in that order,
      // then revalidate and lock its engine. The database attestation trigger
      // remains the final fail-closed backstop, while this classification keeps
      // normal authority races from leaving the setup run leased until timeout.
      const registrationGrant = await tx.query<{ id: string }>(
        `SELECT eg.id
         FROM cloud_workspace_endpoint_grants eg
         JOIN cloud_workspace_engine_instances ei
           ON ei.registration_grant_id = eg.id
          AND ei.workspace_id = eg.workspace_id
          AND ei.generation = eg.generation AND ei.org_id = eg.org_id
          AND ei.account_user_id = eg.account_user_id
          AND ei.setup_run_id = eg.setup_run_id
          AND ei.setup_execution_fence = eg.setup_execution_fence
         WHERE ei.id = $1 AND ei.workspace_id = $2 AND ei.generation = $3
           AND ei.org_id = $4 AND ei.account_user_id = $5
           AND ei.setup_run_id = $6 AND ei.setup_execution_fence = $7
           AND ei.protocol_version = $8 AND eg.purpose = 'setup'
           AND eg.consumed_at IS NOT NULL AND eg.revoked_at IS NULL
         FOR UPDATE OF eg`,
        [
          readiness.engine.instanceId,
          setup.workspaceId,
          setup.generation,
          setup.organizationId,
          setup.authority.accountUserId,
          setup.setupRunId,
          setup.executionFence,
          readiness.engine.protocolVersion,
        ],
      );
      const registrationGrantId = registrationGrant.rows[0]?.id;
      const registeredEngine = registrationGrantId
        ? await tx.query(
            `SELECT 1
             FROM cloud_workspace_engine_instances ei
             WHERE ei.id = $1 AND ei.workspace_id = $2
               AND ei.generation = $3 AND ei.org_id = $4
               AND ei.account_user_id = $5 AND ei.setup_run_id = $6
               AND ei.setup_execution_fence = $7
               AND ei.protocol_version = $8 AND ei.state = 'ready'
               AND ei.revoked_at IS NULL AND ei.lease_expires_at > now()
               AND ei.registration_grant_id = $9
             FOR UPDATE OF ei`,
            [
              readiness.engine.instanceId,
              setup.workspaceId,
              setup.generation,
              setup.organizationId,
              setup.authority.accountUserId,
              setup.setupRunId,
              setup.executionFence,
              readiness.engine.protocolVersion,
              registrationGrantId,
            ],
          )
        : null;

      const eligible =
        current?.current_generation === setup.generation &&
        current.authority_live &&
        current.desired_state === "running" &&
        current.status === "setting_up" &&
        current.observed_state === "running" &&
        current.provider_resource_id === setup.provider.resourceId &&
        (registeredEngine?.rowCount ?? 0) === 1;
      if (!eligible) {
        await tx.query(
          `UPDATE cloud_workspace_setup_runs
           SET state = 'cancelled', completed_at = now(), updated_at = now(),
               error_code = 'setup_publish_ineligible', lease_owner = NULL,
               lease_expires_at = NULL
           WHERE id = $1`,
          [setup.setupRunId],
        );
        await revokeSetupExecutionGrants(tx, setup);
        await retireCloudWorkspaceEngineInstances(tx, setup);
        return false;
      }

      await revokeSetupExecutionGrants(tx, setup);
      await retireCloudWorkspaceEngineInstances(tx, {
        ...setup,
        exceptInstanceId: readiness.engine.instanceId,
      });
      await tx.query(
        `INSERT INTO cloud_workspace_setup_attestations (
           setup_run_id, workspace_id, generation, org_id, execution_fence,
           image_ref, image_source_commit, repository_revision,
           repository_commit, settings_version, settings_snapshot_sha256,
           engine_instance_id, engine_protocol_version, engine_health,
           durable_record_connected
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   decode($11, 'hex'), $12, $13, 'ready', true)`,
        [
          setup.setupRunId,
          setup.workspaceId,
          setup.generation,
          setup.organizationId,
          setup.executionFence,
          readiness.image.ref,
          readiness.image.sourceCommit,
          readiness.repository.revision,
          readiness.repository.commit,
          readiness.settings.version,
          readiness.settings.sha256,
          readiness.engine.instanceId,
          readiness.engine.protocolVersion,
        ],
      );
      await tx.query(
        `UPDATE cloud_workspace_setup_runs
         SET state = 'succeeded', completed_at = now(), updated_at = now(),
             error_code = NULL, lease_owner = NULL, lease_expires_at = NULL,
             log_excerpt = $2, log_truncated = $3
         WHERE id = $1`,
        [setup.setupRunId, log.value, log.truncated],
      );
      await completeCloudWorkspaceGenerationTransition(tx, {
        workspaceId: setup.workspaceId,
        organizationId: setup.organizationId,
        generation: setup.generation,
      });
      await tx.query(
        `UPDATE cloud_workspaces
         SET status = 'ready', version = version + 1,
             last_error_code = NULL, last_error_message = NULL,
             updated_at = now()
         WHERE id = $1`,
        [setup.workspaceId],
      );
      await audit(
        tx,
        setup.organizationId,
        null,
        "cloud_workspace.setup_succeeded",
        {
          workspaceId: setup.workspaceId,
          generation: setup.generation,
          setupRunId: setup.setupRunId,
          attempt: setup.attempt,
          claimCount: setup.claimCount,
          executionFence: setup.executionFence,
          logTruncated: log.truncated,
        },
      );
      return true;
    });
  }

  private async recordFailure(
    setup: ClaimedSetup,
    failure: SafeSetupFailure,
  ): Promise<boolean> {
    return withSystemTx(this.pool, async (tx) => {
      const workspace = await tx.query<{
        current_generation: number;
        desired_state: string;
        status: string;
        provider_resource_id: string | null;
        observed_state: string | null;
        authority_live: boolean;
      }>(
        `SELECT cw.current_generation, cw.desired_state, cw.status,
                pb.provider_resource_id, pb.observed_state,
                EXISTS (
                  SELECT 1
                  FROM organizations organization
                  JOIN teams team
                    ON team.id = cw.team_id
                   AND team.org_id = organization.id
                   AND team.deleted_at IS NULL
                  JOIN organization_members om
                    ON om.org_id = organization.id AND om.user_id = $3
                  JOIN team_members tm
                    ON tm.team_id = team.id AND tm.org_id = organization.id
                   AND tm.user_id = $3
                  JOIN users account
                    ON account.id = $3 AND account.deleted_at IS NULL
                   AND account.auth_status = 'active'
                  WHERE organization.id = cw.org_id
                    AND organization.deleted_at IS NULL
                    AND cloud_workspace_generation_policy_current(
                      cw.id, cw.current_generation, cw.org_id
                    )
                    AND cloud_workspace_runtime_authority_live(
                      cw.id, cw.current_generation, $3, $4
                    )
                ) AS authority_live
         FROM cloud_workspaces cw
         LEFT JOIN cloud_workspace_provider_bindings pb
           ON pb.workspace_id = cw.id
          AND pb.generation = cw.current_generation
         WHERE cw.id = $1 AND cw.org_id = $2
         FOR UPDATE OF cw`,
        [
          setup.workspaceId,
          setup.organizationId,
          setup.authority.accountUserId,
          this.workosEnabled,
        ],
      );
      const current = workspace.rows[0];
      const owned = await tx.query<{ claim_count: number }>(
        `SELECT claim_count FROM cloud_workspace_setup_runs
         WHERE id = $1 AND lease_owner = $2 AND execution_fence = $3
           AND state = 'running' AND lease_expires_at > now()
         FOR UPDATE`,
        [setup.setupRunId, this.workerId, setup.executionFence],
      );
      const run = owned.rows[0];
      if (!run) return false;

      await revokeSetupExecutionGrants(tx, setup);
      await retireCloudWorkspaceEngineInstances(tx, setup);
      const eligible =
        current?.current_generation === setup.generation &&
        current.authority_live &&
        current.desired_state === "running" &&
        current.status === "setting_up" &&
        current.observed_state === "running" &&
        current.provider_resource_id === setup.provider.resourceId;
      if (!eligible) {
        await tx.query(
          `UPDATE cloud_workspace_setup_runs
           SET state = 'cancelled', completed_at = now(), updated_at = now(),
               error_code = 'setup_execution_ineligible', lease_owner = NULL,
               lease_expires_at = NULL
           WHERE id = $1`,
          [setup.setupRunId],
        );
        return false;
      }

      if (failure.retryable && run.claim_count < this.maxClaims) {
        const delayMs = retryDelayMs(run.claim_count, this.retryBaseMs);
        await tx.query(
          `UPDATE cloud_workspace_setup_runs
           SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
               next_attempt_at = now() + ($2::bigint * interval '1 millisecond'),
               error_code = $3, updated_at = now()
           WHERE id = $1`,
          [setup.setupRunId, delayMs, failure.code],
        );
        await audit(
          tx,
          setup.organizationId,
          null,
          "cloud_workspace.setup_retry_scheduled",
          {
            workspaceId: setup.workspaceId,
            generation: setup.generation,
            setupRunId: setup.setupRunId,
            attempt: setup.attempt,
            claimCount: run.claim_count,
            executionFence: setup.executionFence,
            errorCode: failure.code,
            retryDelayMs: delayMs,
          },
        );
        return true;
      }

      await tx.query(
        `UPDATE cloud_workspace_setup_runs
         SET state = 'failed', completed_at = now(), updated_at = now(),
             error_code = $2, lease_owner = NULL, lease_expires_at = NULL
         WHERE id = $1`,
        [setup.setupRunId, failure.code],
      );
      const rolledBack = await rollbackCloudWorkspaceGenerationTransition(tx, {
        workspaceId: setup.workspaceId,
        organizationId: setup.organizationId,
        candidateGeneration: setup.generation,
        errorCode: failure.code,
        errorMessage: "Cloud workspace setup did not complete",
      });
      if (!rolledBack) {
        await tx.query(
          `UPDATE cloud_workspaces
           SET status = 'failed', version = version + 1,
               last_error_code = $2,
               last_error_message = 'Cloud workspace setup did not complete',
               updated_at = now()
           WHERE id = $1`,
          [setup.workspaceId, failure.code],
        );
        await failCloudWorkspaceGenerationRollback(tx, {
          workspaceId: setup.workspaceId,
          organizationId: setup.organizationId,
          sourceGeneration: setup.generation,
          errorCode: failure.code,
          errorMessage: "Cloud workspace setup did not complete",
        });
        await retireCloudWorkspaceRuntimeAccess(tx, {
          workspaceId: setup.workspaceId,
          organizationId: setup.organizationId,
          generation: setup.generation,
          reason: "setup_failed",
        });
      }
      await audit(
        tx,
        setup.organizationId,
        null,
        "cloud_workspace.setup_failed",
        {
          workspaceId: setup.workspaceId,
          generation: setup.generation,
          setupRunId: setup.setupRunId,
          attempt: setup.attempt,
          claimCount: run.claim_count,
          executionFence: setup.executionFence,
          errorCode: failure.code,
        },
      );
      return true;
    });
  }

  private executionLog(result: CloudWorkspaceSetupResult): {
    value: string;
    truncated: boolean;
  } {
    try {
      const bounded = boundedCloudWorkspaceSetupLog(
        this.sanitizeLog(result.logExcerpt ?? ""),
      );
      return {
        value: bounded.value,
        truncated: bounded.truncated || result.logTruncated === true,
      };
    } catch {
      this.logger.warn("[cloud-workspace] setup log sanitizer failed");
      return { value: "", truncated: true };
    }
  }

  private async execute(setup: ClaimedSetup): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let abortFailure: SafeSetupFailure | null = null;
    let heartbeatInFlight: Promise<void> | null = null;

    const abort = (failure: SafeSetupFailure) => {
      if (abortFailure) return;
      abortFailure = failure;
      controller.abort();
    };
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight || controller.signal.aborted) return;
      heartbeatInFlight = this.renewLease(setup)
        .then((renewed) => {
          if (!renewed) abort({ code: "setup_lease_lost", retryable: true });
        })
        .catch((error) => {
          this.logger.warn(
            `[cloud-workspace] setup heartbeat failed: ${
              error instanceof Error ? error.name : "unknown"
            }`,
          );
          abort({ code: "setup_heartbeat_failed", retryable: true });
        })
        .finally(() => {
          heartbeatInFlight = null;
        });
    }, this.heartbeatMs);
    heartbeat.unref();
    const timeout = setTimeout(
      () => abort({ code: "setup_timed_out", retryable: true }),
      this.executionTimeoutMs,
    );
    timeout.unref();

    let result: CloudWorkspaceSetupResult | null = null;
    let failure: SafeSetupFailure | null = null;
    let abortListener: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(SETUP_EXECUTION_ABORTED);
      if (controller.signal.aborted) {
        abortListener();
        return;
      }
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    // The executor contract requires AbortSignal support, but a provider SDK
    // regression must not make process shutdown or lease recovery hang forever.
    // Admission expiry and the execution fence make a late ignored command
    // unable to publish readiness after this bounded side wins the race.
    const execution = Promise.resolve().then(() =>
      this.executor.execute(setup, controller.signal),
    );
    try {
      result = await Promise.race([execution, aborted]);
    } catch (error) {
      if (error !== SETUP_EXECUTION_ABORTED) failure = safeFailure(error);
    } finally {
      if (abortListener) {
        controller.signal.removeEventListener("abort", abortListener);
      }
      // Promise.race installs a rejection handler, and this explicit drain
      // documents that a late provider rejection is intentionally discarded.
      void execution.catch(() => undefined);
      clearInterval(heartbeat);
      clearTimeout(timeout);
      await heartbeatInFlight;
      this.activeControllers.delete(controller);
    }

    if (!abortFailure && controller.signal.aborted) {
      abortFailure = { code: "setup_worker_stopped", retryable: true };
    }
    if (abortFailure || failure) {
      await this.recordFailure(
        setup,
        abortFailure ??
          failure ?? {
            code: "setup_unknown_failure",
            retryable: true,
          },
      );
      return;
    }
    if (
      !result ||
      !cloudWorkspaceSetupReadinessMatches(setup, result.readiness)
    ) {
      await this.recordFailure(setup, {
        code: "setup_readiness_invalid",
        retryable: false,
      });
      return;
    }
    await this.recordSuccess(
      setup,
      result.readiness,
      this.executionLog(result),
    );
  }

  async runOnce(): Promise<boolean> {
    const decision = await this.claim();
    if (decision.kind === "none") return false;
    if (decision.kind === "claimed") await this.execute(decision.setup);
    return true;
  }
}

export function startCloudWorkspaceSetupWorker(
  options: CloudWorkspaceSetupWorkerOptions,
): { worker: CloudWorkspaceSetupWorker; stop: () => Promise<void> } {
  const worker = new CloudWorkspaceSetupWorker(options);
  return { worker, stop: worker.start() };
}
