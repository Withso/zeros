import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";
import {
  seedSupportedCloudWorkspaceGeneration,
  seedCanonicalCloudWorkspaceAuthority,
  seedCanonicalCloudWorkspacePrerequisites,
  seedCanonicalWorkspaceSettingsVersion,
} from "./test-fixtures.js";
import {
  CloudWorkspaceSetupError,
  CloudWorkspaceSetupWorker,
  type CloudWorkspaceSetupExecution,
  type CloudWorkspaceSetupExecutor,
  type CloudWorkspaceSetupReadiness,
  type CloudWorkspaceSetupResult,
} from "./setup-worker.js";
import { runtimeBase, runtimeWitness, seedRuntimeGeneration, seedRuntimeBundle } from "./runtime-test-fixtures.js";
import { cloudRuntimePinValues, loadPinnedCloudRuntime } from "./runtime-selection.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { CloudWorkspaceLinuxSetupExecutor, type CloudWorkspaceSetupAdmissionBroker } from "./linux-setup-executor.js";
import { DatabaseCloudWorkspaceSetupAdmissionBroker } from "./setup-admission-broker.js";
import { consumeCloudWorkspaceGrant } from "./grants.js";
import { CloudProviderError, type CloudWorkspaceCommandRunner } from "./provider.js";
import { parseCloudWorkspaceSetupRequest, redactCloudWorkspaceSetupHookLog } from "../../../../scripts/cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs";
vi.mock("../../../../scripts/cloud-workspace-validation/sandbox/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../../../../scripts/cloud-workspace-validation/sandbox/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../../desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime.js")).testCloudRuntime,
}));

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  resolve(value: T): void {
    this.resolvePromise(value);
  }
}

type ExecuteHandler = (
  execution: CloudWorkspaceSetupExecution,
  signal: AbortSignal,
) => Promise<CloudWorkspaceSetupResult>;

class FakeExecutor implements CloudWorkspaceSetupExecutor {
  readonly calls: CloudWorkspaceSetupExecution[] = [];
  readonly signals: AbortSignal[] = [];

  constructor(private readonly handlers: ExecuteHandler[]) {}

  async execute(
    execution: CloudWorkspaceSetupExecution,
    signal: AbortSignal,
  ): Promise<CloudWorkspaceSetupResult> {
    this.calls.push(execution);
    this.signals.push(signal);
    const handler = this.handlers.shift();
    if (!handler) throw new Error("Unexpected setup execution");
    return handler(execution, signal);
  }
}

function successfulSetup(
  execution: CloudWorkspaceSetupExecution,
  logExcerpt: string,
): CloudWorkspaceSetupResult {
  const readiness: CloudWorkspaceSetupReadiness = {
    version: 1,
    setupRunId: execution.setupRunId,
    workspaceId: execution.workspaceId,
    organizationId: execution.organizationId,
    generation: execution.generation,
    executionFence: execution.executionFence,
    image: {
      ref: execution.image.ref,
      sourceCommit: execution.image.sourceCommit!,
    },
    repository: {
      revision: execution.repository.revision,
      commit: "c".repeat(40),
    },
    settings: {
      version: execution.settings.version,
      sha256: execution.settings.sha256,
    },
    engine: {
      instanceId: randomUUID(),
      protocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
      health: "ready",
      durableRecordConnected: true,
    },
  };
  return { readiness, logExcerpt };
}

d("cloud workspace setup worker", () => {
  let pool: pg.Pool;
  let organizationId: string;
  let teamId: string;
  let ownerId: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 8 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await pool.query("UPDATE managed_compute_provider_requirements SET require_credit=false WHERE provider='boat'");
    ownerId = randomUUID();
    await pool.query(`INSERT INTO users(id,email,display_name,staff_role)
      VALUES ($1,$2,'Setup Owner','developer')`, [ownerId, `setup-${ownerId}@example.test`]);
    const seeded = await withSystemTx(pool, async (tx) => {

      const organization = await tx.query<{ id: string }>(
        `INSERT INTO organizations (
           slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, 'Setup Org', $2, false, true) RETURNING id`,
        [`setup-${randomUUID()}`, ownerId],
      );
      const orgId = organization.rows[0]!.id;
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [orgId, ownerId],
      );
      const team = await tx.query<{ id: string }>(
        `INSERT INTO teams (org_id, slug, name, is_default, created_by)
         VALUES ($1, 'default', 'Default', true, $2) RETURNING id`,
        [orgId, ownerId],
      );
      const seededTeamId = team.rows[0]!.id;
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [seededTeamId, orgId, ownerId],
      );
      return { orgId, teamId: seededTeamId };
    });
    organizationId = seeded.orgId;
    teamId = seeded.teamId;
  });

  const seedSetup = async (input?: {
    v4?: boolean;
    supportedGeneration?: boolean;
    state?: "queued" | "running";
    claimCount?: number;
    executionFence?: number;
    leaseOwner?: string | null;
    leaseExpired?: boolean;
  }) => {
    if (input?.v4) await pool.query("UPDATE managed_compute_provider_requirements SET require_credit=false WHERE provider='boat'");
    const workspaceId = randomUUID();
    const settingsSnapshot = { schemaVersion: 1, values: {} };
    const result = await withSystemTx(pool, async (tx) => {
      const canonical = await seedCanonicalCloudWorkspacePrerequisites(tx, {
        organizationId,
        ownerUserId: ownerId,
      });
      await tx.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, repository_id, owner_user_id,
           assignee_user_id, status, desired_state
         ) VALUES ($1, $2, $3, $4, 'Setup Workspace', 'github.com',
                   'withso', 'zeros', 'main', $5, $4, $4,
                   'setting_up', 'running')`,
        [workspaceId, organizationId, teamId, ownerId, canonical.repositoryId],
      );
      await seedCanonicalCloudWorkspaceAuthority(tx, {
        workspaceId,
        organizationId,
        ownerUserId: ownerId,
      });
      if (input?.v4 !== false && input?.supportedGeneration !== false) await seedSupportedCloudWorkspaceGeneration(tx, { workspaceId, organizationId, ownerUserId: ownerId, providerConnectionId: canonical.providerConnectionId });
      else if (input?.v4) await seedRuntimeGeneration(tx, { workspaceId, organizationId, ownerUserId: ownerId });
      else {
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         ) VALUES ($1, 1, $2, 'boat', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480, $3, $4, $5)`,
        [
          workspaceId,
          organizationId,
          "a".repeat(40),
          ownerId,
          canonical.providerConnectionId,
        ],
      );
      }
      const settingsVersionId = await seedCanonicalWorkspaceSettingsVersion(
        tx,
        {
          workspaceId,
          organizationId,
          generation: 1,
          createdBy: ownerId,
          effectiveDocument: settingsSnapshot,
        },
      );
      await tx.query(
        `INSERT INTO cloud_workspace_setup_specs (
           workspace_id, generation, org_id, repository_forge,
           repository_owner, repository_name, repository_revision,
           settings_snapshot, settings_snapshot_sha256,
           workspace_settings_version_id
         ) VALUES ($1, 1, $2, 'github.com', 'withso', 'zeros', 'main',
                   $3::jsonb, digest($3::jsonb::text, 'sha256'), $4)`,
        [
          workspaceId,
          organizationId,
          JSON.stringify(settingsSnapshot),
          settingsVersionId,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider,
           provider_resource_id, observed_state, last_observed_at
         ) VALUES ($1, 1, $2, $4, $3, 'running', now())`,
        [workspaceId, organizationId, `sandbox-${workspaceId}`, 'boat'],
      );
      const state = input?.state ?? "queued";
      const running = state === "running";
      const setup = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspace_setup_runs (
           workspace_id, generation, org_id, attempt, state, claim_count,
           execution_fence, lease_owner, lease_expires_at,
           last_heartbeat_at, started_at
         ) VALUES (
           $1, 1, $2, 1, $3::cloud_workspace_setup_state, $4, $5,
           $6, CASE WHEN $7 THEN now() - interval '1 second' ELSE NULL END,
           CASE WHEN $7 THEN now() - interval '1 minute' ELSE NULL END,
           CASE WHEN $7 THEN now() - interval '1 minute' ELSE NULL END
         ) RETURNING id`,
        [
          workspaceId,
          organizationId,
          state,
          input?.claimCount ?? 0,
          input?.executionFence ?? 0,
          input?.leaseOwner ?? null,
          running && (input?.leaseExpired ?? false),
        ],
      );
      return {
        setupRunId: setup.rows[0]!.id,
        providerConnectionId: canonical.providerConnectionId,
      };
    });
    return {
      workspaceId,
      setupRunId: result.setupRunId,
      providerConnectionId: result.providerConnectionId,
      settingsSnapshot,
    };
  };

  it.each([{ v4: false }, { v4: true, supportedGeneration: false }])(
    "refuses unsupported setup before executor or grant issuance (%j)", async options => {
      const seeded = await seedSetup(options);
      const execute = vi.fn(async (execution: CloudWorkspaceSetupExecution) => successfulSetup(execution, ""));
      const worker = new CloudWorkspaceSetupWorker({ pool, executor: { execute }, sanitizeLog: value => value, intervalMs: 1_000 });
      expect(await worker.runOnce()).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect((await pool.query("SELECT state,error_code FROM cloud_workspace_setup_runs WHERE id=$1", [seeded.setupRunId])).rows[0])
        .toMatchObject({ state: "failed", error_code: "cloud_workspace_v2_required" });
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_endpoint_grants WHERE workspace_id=$1", [seeded.workspaceId])).rows[0].n).toBe(0);
    },
  );

  const seedReplacementSetup = async () => {
    const seeded = await seedSetup();
    const transitionId = randomUUID();
    const provisionIntentId = randomUUID();
    const setupRunId = await withSystemTx(pool, async (tx) => {
      await seedSupportedCloudWorkspaceGeneration(tx, {
        workspaceId: seeded.workspaceId, organizationId, ownerUserId: ownerId, generation: 2, providerConnectionId: seeded.providerConnectionId,
      });
      const settingsVersionId = await seedCanonicalWorkspaceSettingsVersion(
        tx,
        {
          workspaceId: seeded.workspaceId,
          organizationId,
          generation: 2,
          createdBy: ownerId,
          effectiveDocument: seeded.settingsSnapshot,
        },
      );
      await tx.query(
        `INSERT INTO cloud_workspace_setup_specs (
           workspace_id, generation, org_id, repository_forge,
           repository_owner, repository_name, repository_revision,
           settings_snapshot, settings_snapshot_sha256,
           workspace_settings_version_id
         ) VALUES ($1, 2, $2, 'github.com', 'withso', 'zeros', 'main',
                   $3::jsonb, digest($3::jsonb::text, 'sha256'), $4)`,
        [
          seeded.workspaceId,
          organizationId,
          JSON.stringify(seeded.settingsSnapshot),
          settingsVersionId,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider,
           provider_resource_id, observed_state, last_observed_at
         ) VALUES ($1, 2, $2, 'boat', $3, 'running', now())`,
        [seeded.workspaceId, organizationId, `sandbox-${seeded.workspaceId}-2`],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_lifecycle_intents (
           id, workspace_id, generation, org_id, requested_by, operation,
           idempotency_key, request_sha256, state, completed_at
         ) VALUES ($1, $2, 2, $3, $4, 'create', $5, $6,
                   'succeeded', now())`,
        [
          provisionIntentId,
          seeded.workspaceId,
          organizationId,
          ownerId,
          randomUUID(),
          createHash("sha256").update(randomUUID()).digest(),
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generation_transitions (
           id, workspace_id, org_id, requested_by, operation,
           source_generation, template_generation, candidate_generation,
           state, provision_intent_id
         ) VALUES ($1, $2, $3, $4, 'upgrade', 1, 1, 2,
                   'setting_up', $5)`,
        [
          transitionId,
          seeded.workspaceId,
          organizationId,
          ownerId,
          provisionIntentId,
        ],
      );
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET generation_transition_id = $2 WHERE id = $1`,
        [provisionIntentId, transitionId],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET current_generation = 2, status = 'setting_up',
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [seeded.workspaceId],
      );
      const setup = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspace_setup_runs (
           workspace_id, generation, org_id, attempt
         ) VALUES ($1, 2, $2, 1) RETURNING id`,
        [seeded.workspaceId, organizationId],
      );
      return setup.rows[0]!.id;
    });
    return { ...seeded, setupRunId, transitionId, provisionIntentId };
  };

  const worker = (
    executor: CloudWorkspaceSetupExecutor,
    input: {
      workerId?: string;
      maxClaims?: number;
      leaseMs?: number;
      heartbeatMs?: number;
      sanitizeLog?: (value: string) => string;
      pool?: pg.Pool;
    } = {},
  ) =>
    new CloudWorkspaceSetupWorker({
      pool: input.pool ?? pool,
      executor,
      sanitizeLog:
        input.sanitizeLog ??
        ((value) => value.replaceAll("secret-value", "[redacted]")),
      intervalMs: 1_000,
      leaseMs: input.leaseMs ?? 10_000,
      heartbeatMs: input.heartbeatMs ?? 4_000,
      executionTimeoutMs: 30_000,
      retryBaseMs: 1_000,
      maxClaims: input.maxClaims ?? 3,
      workerId: input.workerId ?? `setup-worker-${randomUUID()}`,
      logger: { info() {}, warn() {}, error() {} },
    });

  const registeredSuccessfulSetup = async (
    execution: CloudWorkspaceSetupExecution,
    logExcerpt: string,
  ): Promise<CloudWorkspaceSetupResult> => {
    const result = successfulSetup(execution, logExcerpt);
    await withSystemTx(pool, async (tx) => {
      const grant = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspace_endpoint_grants (
           workspace_id, generation, org_id, account_user_id, purpose,
           audience, token_hash, account_revision, authorization_revision,
           expires_at, consumed_at, setup_run_id,
           setup_execution_fence
         ) VALUES ($1, $2, $3, $4, 'setup', $5, $6,
                   1, 1, now() + interval '5 minutes', now(), $7, $8)
         RETURNING id`,
        [
          execution.workspaceId,
          execution.generation,
          execution.organizationId,
          ownerId,
          "https://control.example.test/internal/v1/cloud-workspaces/engine/register",
          createHash("sha256").update(randomUUID()).digest(),
          execution.setupRunId,
          execution.executionFence,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_engine_instances (
           id, workspace_id, generation, org_id, account_user_id,
           setup_run_id, setup_execution_fence, registration_grant_id,
           protocol_version, actor_protocol_version, state, bridge_token_hash,
           heartbeat_token_hash, registered_at, last_heartbeat_at,
           lease_expires_at, runtime_id, runtime_manifest_sha256, runtime_base_image_id, runtime_base_compatibility_id,
           runtime_profile, runtime_engine_protocol_version, runtime_installer_receipt_sha256, runtime_boot_id, runtime_supervisor_session_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2, 'ready',
                   $10, $11, now(), now(), now() + interval '2 minutes', $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          result.readiness.engine.instanceId,
          execution.workspaceId,
          execution.generation,
          execution.organizationId,
          ownerId,
          execution.setupRunId,
          execution.executionFence,
          grant.rows[0]!.id,
          CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
          createHash("sha256").update(randomUUID()).digest(),
          createHash("sha256").update(randomUUID()).digest(),
          ...cloudRuntimePinValues(execution.runtime),
          ...(execution.runtime ? [runtimeWitness.installerReceiptSha256, runtimeWitness.bootId, runtimeWitness.supervisorSessionId] : [null, null, null]),
        ],
      );
    });
    return result;
  };

  const installerSuccess = { schema: "zeros.diagnostic/v1", component: "installer", stage: "done", ok: true,
    exitCode: 0, timedOut: false, failedChecks: [] };
  const admissionEndpoint = "https://control.example.test/internal/v1/cloud-workspaces/setup/admission";
  const linuxSetupOptions = (admissionBroker: CloudWorkspaceSetupAdmissionBroker, commandRunner: CloudWorkspaceCommandRunner) => ({
    admissionBroker, commandRunner, diagnosticPool: pool,
    engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, timeoutSeconds: 1800,
    resolveRuntimeArtifact: (pin: NonNullable<CloudWorkspaceSetupExecution["runtime"]>) => withSystemTx(pool, tx => loadPinnedCloudRuntime(tx, pin, "full")),
    runtimeArtifacts: { presignCreatePut: vi.fn(), head: vi.fn(),
      presignGet: vi.fn(async () => ({ url: "https://artifacts.example.test/runtime?signature=private-runtime-delivery",
        expiresAt: new Date(Date.now() + 900_000).toISOString() })) },
  });

  it.each([
    { source: "typed", outcome: "recover" },
    { source: "typed", outcome: "exhaust" },
    { source: "typed", outcome: "reject" },
    { source: "http", outcome: "recover" },
    { source: "http", outcome: "exhaust" },
    { source: "timeout", outcome: "recover" },
    { source: "reset", outcome: "exhaust" },
  ] as const)("keeps transient v4 provider failures quiet until a terminal outcome: $source $outcome", async ({ source, outcome }) => {
    const seeded = await seedSetup({ v4: true });
    const broker = new DatabaseCloudWorkspaceSetupAdmissionBroker({ pool, endpoint: admissionEndpoint });
    const transient = source === "typed"
      ? new CloudProviderError("provider_request_failed", "private-provider-body", outcome !== "reject", { httpStatus: outcome === "reject" ? 401 : 503 })
      : Object.assign(new Error("private-provider-body"), source === "http" ? { status: 503 } : source === "timeout" ? { name: "TimeoutError" } : { code: "ECONNRESET" });
    const runner = { execute: vi.fn(async () => { throw transient; }) };
    const linux = new CloudWorkspaceLinuxSetupExecutor(linuxSetupOptions(broker, runner));
    const executor = new FakeExecutor([
      (execution, signal) => linux.execute(execution, signal),
      outcome === "recover" ? execution => registeredSuccessfulSetup(execution, "recovered") : (execution, signal) => linux.execute(execution, signal),
    ]);
    const instance = worker(executor, { maxClaims: 2 });
    await instance.runOnce();
    const incidents = () => pool.query("SELECT id,terminal_cause FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1", [seeded.setupRunId]);
    if (outcome === "reject") {
      expect((await incidents()).rows).toHaveLength(1);
      expect((await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1", [seeded.workspaceId])).rows[0].status).toBe("failed");
      return;
    }
    expect((await incidents()).rows).toHaveLength(0);
    expect((await pool.query("SELECT status,last_error_code FROM cloud_workspaces WHERE id=$1", [seeded.workspaceId])).rows[0])
      .toEqual({ status: "setting_up", last_error_code: null });
    await pool.query("UPDATE cloud_workspace_setup_runs SET next_attempt_at=clock_timestamp() WHERE id=$1", [seeded.setupRunId]);
    await instance.runOnce();
    if (outcome === "recover") {
      expect((await incidents()).rows).toHaveLength(0);
      expect((await pool.query("SELECT status,last_error_code FROM cloud_workspaces WHERE id=$1", [seeded.workspaceId])).rows[0])
        .toEqual({ status: "ready", last_error_code: null });
    } else {
      expect((await incidents()).rows).toHaveLength(1);
      expect((await incidents()).rows[0].terminal_cause).toMatchObject({
        ...(source === "typed" || source === "http" ? { httpClass: "5xx" } : {}), retryable: true, decision: "reject_setup" });
      expect((await pool.query("SELECT status,last_error_code FROM cloud_workspaces WHERE id=$1", [seeded.workspaceId])).rows[0])
        .toEqual({ status: "failed", last_error_code: source === "typed" ? "setup_provider_request_failed" : "setup_provider_failure" });
    }
    expect(JSON.stringify((await incidents()).rows)).not.toContain("private-provider-body");
  });

  it.each([
    { v4: true, elapsedMs: 180_000, ttlSeconds: 900 },
    { v4: true, elapsedMs: 600_000, ttlSeconds: 900 },
  ])("keeps a single admission redeemable at helper entry after $elapsedMs ms (v4=$v4)", async ({ v4, elapsedMs, ttlSeconds }) => {
    const seeded = await seedSetup({ v4 });
    const broker = new DatabaseCloudWorkspaceSetupAdmissionBroker({ pool, endpoint: admissionEndpoint });
    const issue = vi.spyOn(broker, "issue");
    let helperAccepted = false;
    let observedTtlMs = 0;
    const executor = new FakeExecutor([async (execution, signal) => {
      const linux = new CloudWorkspaceLinuxSetupExecutor(linuxSetupOptions(broker, {
        execute: async input => {
          const encoded = input.env!.ZEROS_CLOUD_WORKSPACE_SETUP_B64;
          const nested = v4 ? JSON.parse(Buffer.from(encoded, "base64url").toString()).setup : encoded;
          const issuedAt = JSON.parse(Buffer.from(nested, "base64url").toString()).issuedAtMs;
          let request: ReturnType<typeof parseCloudWorkspaceSetupRequest>;
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(issuedAt + elapsedMs);
          try {
            // Use the actual helper parser after download/verification/startup,
            // including its five-second remaining-lifetime requirement.
            request = parseCloudWorkspaceSetupRequest(nested);
            helperAccepted = true;
            observedTtlMs = request.admission.expiresAtMs - request.issuedAtMs;
          } finally { vi.useRealTimers(); }
          const consume = () => withSystemTx(pool, tx => consumeCloudWorkspaceGrant(tx, {
            token: request.admission.token, audience: admissionEndpoint, purpose: "setup",
            workspaceId: execution.workspaceId, organizationId: execution.organizationId, generation: execution.generation,
            accountUserId: execution.authority.accountUserId,
            setup: { setupRunId: execution.setupRunId, executionFence: execution.executionFence },
          }));
          expect(await consume() !== null).toBe(true);
          expect(await consume()).toBeNull();
          const ready = await registeredSuccessfulSetup(execution, "setup completed");
          const helper = JSON.stringify({ version: 1, audience: "zeros-cloud-workspace-setup-result-v1", outcome: "ready", readiness: ready.readiness });
          return { exitCode: 0, outputTruncated: false, output: helper + (v4 ? "\n" + JSON.stringify(installerSuccess) : "") };
        },
      }));
      return linux.execute(execution, signal);
    }]);
    await worker(executor).runOnce();
    expect(helperAccepted).toBe(true);
    expect(observedTtlMs).toBeGreaterThan((ttlSeconds - 1) * 1000);
    expect(observedTtlMs).toBeLessThanOrEqual(ttlSeconds * 1000);
    expect(issue).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT state FROM cloud_workspace_setup_runs WHERE id=$1", [seeded.setupRunId])).rows[0].state).toBe("succeeded");
    const retired = await pool.query(`SELECT consumed_at IS NOT NULL AS consumed, revoked_at IS NOT NULL AS revoked
      FROM cloud_workspace_endpoint_grants WHERE setup_run_id=$1 AND audience=$2`, [seeded.setupRunId, admissionEndpoint]);
    expect(retired.rows).toEqual([{ consumed: true, revoked: true }]);
  });

  it.each([true, false])("persists closed stage timings for a current setup claim (success=%s)", async success => {
    const seeded = await seedSetup({ v4: true });
    const timings = { version: 1, clocks: [{ source: "setup", clockId: randomUUID(), startedAt: "2026-10-06T00:00:00.000Z",
      spans: [{ stage: "repository", startMs: 10, endMs: 25, outcome: success ? "passed" : "failed" }] }] };
    const executor = new FakeExecutor([async execution => {
      if (!success) throw Object.assign(new CloudWorkspaceSetupError("setup_command_failed", "closed", false), { timings });
      return { ...await registeredSuccessfulSetup(execution, ""), timings };
    }]);
    await worker(executor).runOnce();
    const stored = (await pool.query("SELECT stage_timings FROM cloud_workspace_setup_runs WHERE id=$1", [seeded.setupRunId])).rows[0];
    expect(stored.stage_timings).toEqual(timings);
    for (const invalid of [{ ...timings, text: "private" }, { version: 1, clocks: [{ ...timings.clocks[0], source: "private" }] },
      { version: 1, clocks: [{ ...timings.clocks[0], spans: [{ stage: "repository", startMs: 25, endMs: 10, outcome: "passed" }] }] }]) {
      await expect(pool.query("UPDATE cloud_workspace_setup_runs SET stage_timings=$2 WHERE id=$1", [seeded.setupRunId, invalid])).rejects.toMatchObject({ code: "23514" });
    }
  });

  describe("durable retry deadlines", () => {
    const nextDelay = (value: CloudWorkspaceSetupWorker) =>
      (value as unknown as { readNextDelayMs(): Promise<number | null> }).readNextDelayMs();

    it("reads a future queued retry and the current running lease rather than its old retry date", async () => {
      const seeded = await seedSetup({ v4: true });
      const current = worker(new FakeExecutor([]));
      await pool.query("UPDATE cloud_workspace_setup_runs SET next_attempt_at=now()+interval '2 seconds' WHERE id=$1", [seeded.setupRunId]);
      const queued = await nextDelay(current);
      expect(queued).toBeGreaterThan(0); expect(queued).toBeLessThanOrEqual(2_000);
      await pool.query(`UPDATE cloud_workspace_setup_runs SET state='running',lease_owner='other-worker',
        lease_expires_at=now()+interval '3 seconds',next_attempt_at=now()+interval '1 minute',
        claim_count=1,execution_fence=1,started_at=now(),last_heartbeat_at=now() WHERE id=$1`, [seeded.setupRunId]);
      const leased = await nextDelay(current);
      expect(leased).toBeGreaterThan(2_000); expect(leased).toBeLessThanOrEqual(3_000);
      await pool.query("UPDATE cloud_workspace_setup_runs SET state='cancelled',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [seeded.setupRunId]);
      expect(await nextDelay(current)).toBeNull();
    });

    it.each(["stopped", "binding", "membership", "deleted"])("ignores a queued retry after %s makes it ineligible", async reason => {
      const seeded = await seedSetup({ v4: true });
      if (reason === "stopped") await pool.query("UPDATE cloud_workspaces SET desired_state='stopped',status='stopped' WHERE id=$1", [seeded.workspaceId]);
      if (reason === "binding") await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='stopped' WHERE workspace_id=$1", [seeded.workspaceId]);
      if (reason === "membership") await pool.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [teamId, ownerId]);
      if (reason === "deleted") await pool.query("UPDATE cloud_workspaces SET deleted_at=now(),desired_state='deleted',status='deleted' WHERE id=$1", [seeded.workspaceId]);
      expect(await nextDelay(worker(new FakeExecutor([])))).toBeNull();
    });
  });

  it("persists distinct closed installer failures without URL or token-like input", async () => {
    const seeded = await seedSetup({ v4: true });
    const broker = new DatabaseCloudWorkspaceSetupAdmissionBroker({ pool, endpoint: admissionEndpoint });
    const tokenCanary = ["ghp", "synthetic-installer-canary"].join("_");
    const urlCanary = `https://untrusted.example.test/runtime?signature=${tokenCanary}`;
    const archive = { ...installerSuccess, stage: "verify_archive", ok: false, exitCode: 1, failedChecks: ["archive_digest"] };
    const space = { ...archive, stage: "check_space", failedChecks: ["insufficient_space"] };
    const executor = new FakeExecutor([async (execution, signal) => {
      const runner = { execute: vi.fn(async () => ({ exitCode: 1, output: "", outputTruncated: false })) };
      const options = linuxSetupOptions(broker, runner);
      const linux = new CloudWorkspaceLinuxSetupExecutor(options);
      let lastFailure: unknown;
      for (const diagnostic of [archive, archive, space,
        { ...archive, component: tokenCanary }, { ...archive, stage: urlCanary },
        { ...archive, failedChecks: [tokenCanary] }, { ...archive, message: urlCanary },
      ]) {
        runner.execute.mockResolvedValueOnce({ exitCode: 1, output: JSON.stringify(diagnostic), outputTruncated: false });
        lastFailure = await linux.execute(execution, signal).catch(error => error);
      }
      options.runtimeArtifacts.presignGet.mockRejectedValueOnce(new Error(urlCanary + " " + tokenCanary));
      lastFailure = await linux.execute(execution, signal).catch(error => error);
      options.runtimeArtifacts.presignGet.mockResolvedValueOnce({ url: urlCanary, expiresAt: new Date(Date.now() + 901_000).toISOString() });
      lastFailure = await linux.execute(execution, signal).catch(error => error);
      throw lastFailure;
    }]);
    await worker(executor).runOnce();
    const incidents = (await pool.query("SELECT first_cause,terminal_cause,events FROM cloud_workspace_diagnostic_incidents WHERE operation_id=$1", [seeded.setupRunId])).rows;
    expect(incidents).toHaveLength(1);
    expect(incidents[0].first_cause).toMatchObject({ code: "setup_runtime_install_failed", phase: "runtime",
      setup: { version: 1, phase: "runtime", installer: archive } });
    expect(incidents[0].terminal_cause).toMatchObject({ code: "setup_runtime_input_invalid", phase: "runtime" });
    const installers = incidents[0].events.flatMap((event: { diagnostic: { setup?: { installer?: unknown } } }) =>
      event.diagnostic.setup?.installer ? [event.diagnostic.setup.installer] : []);
    expect(installers).toEqual([archive, space]);
    expect(incidents[0].events[0].count).toBe(2);
    const logs = (await pool.query(`SELECT run.log_excerpt,run.error_code,workspace.last_error_message
      FROM cloud_workspace_setup_runs run JOIN cloud_workspaces workspace ON workspace.id=run.workspace_id
      WHERE run.id=$1`, [seeded.setupRunId])).rows;
    const serialized = JSON.stringify({ incidents, logs });
    for (const forbidden of [tokenCanary, urlCanary, "https://artifacts.example.test", "private-runtime-delivery"])
      expect(serialized.includes(forbidden)).toBe(false);
  });

  it("retains a v4 generation pin across retries and persists its registered nine-field witness at readiness", async () => {
    const seeded = await seedSetup({ v4: true });
    const executor = new FakeExecutor([
      async () => { throw new CloudWorkspaceSetupError("setup_repository_unavailable", "retry fixture", true); },
      async execution => registeredSuccessfulSetup(execution, "v4 setup completed"),
    ]);
    const instance = worker(executor);
    await instance.runOnce();
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "2", releaseOrder: 2 }));
    await pool.query("UPDATE cloud_workspace_setup_runs SET next_attempt_at=now() WHERE id=$1", [seeded.setupRunId]);
    await instance.runOnce();
    expect(executor.calls[0]?.runtime).toEqual(executor.calls[1]?.runtime);
    expect(executor.calls[1]?.runtime).toMatchObject({ runtimeId: runtimeWitness.runtimeId, baseImageId: runtimeBase.id });
    const saved = (await pool.query(`SELECT attestation.runtime_id, attestation.runtime_manifest_sha256,
      attestation.runtime_base_image_id, attestation.runtime_base_compatibility_id, attestation.runtime_profile,
      attestation.runtime_engine_protocol_version, attestation.runtime_installer_receipt_sha256, attestation.runtime_boot_id,
      attestation.runtime_supervisor_session_id FROM cloud_workspace_setup_attestations attestation WHERE setup_run_id=$1`, [seeded.setupRunId])).rows[0];
    expect(saved).toEqual({ runtime_id: runtimeWitness.runtimeId, runtime_manifest_sha256: runtimeWitness.manifestSha256,
      runtime_base_image_id: runtimeBase.id, runtime_base_compatibility_id: runtimeBase.compatibilityId,
      runtime_profile: "zeros-cloud-worker-v4", runtime_engine_protocol_version: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
      runtime_installer_receipt_sha256: runtimeWitness.installerReceiptSha256, runtime_boot_id: runtimeWitness.bootId,
      runtime_supervisor_session_id: runtimeWitness.supervisorSessionId });
  });
  it("fails a revoked v4 setup retry before executing the installer", async () => {
    const seeded = await seedSetup({ v4: true });
    const executor = new FakeExecutor([
      async () => { throw new CloudWorkspaceSetupError("setup_repository_unavailable", "retry fixture", true); },
      async execution => registeredSuccessfulSetup(execution, "must not execute"),
    ]);
    const instance = worker(executor);
    await instance.runOnce();
    await withSystemTx(pool, async tx => {
      await seedRuntimeBundle(tx, { digit: "2", releaseOrder: 2 });
      await tx.query("UPDATE cloud_runtime_bundles SET revoked_at=now() WHERE runtime_id=$1", [runtimeWitness.runtimeId]);
      await tx.query("UPDATE cloud_workspace_setup_runs SET next_attempt_at=now() WHERE id=$1", [seeded.setupRunId]);
    });
    await instance.runOnce();
    expect(executor.calls).toHaveLength(1);
    expect((await pool.query("SELECT state,error_code FROM cloud_workspace_setup_runs WHERE id=$1", [seeded.setupRunId])).rows[0])
      .toEqual({ state: "failed", error_code: "cloud_runtime_revoked" });
    expect((await pool.query("SELECT last_error_code,last_error_message FROM cloud_workspaces WHERE id=$1", [seeded.workspaceId])).rows[0])
      .toMatchObject({ last_error_code: "cloud_runtime_revoked", last_error_message: expect.stringContaining("upgrade") });
  });

  it("reports a revoked v4 pin when its qualification is revoked during setup", async () => {
    const seeded = await seedSetup({ v4: true });
    const executor = new FakeExecutor([async execution => {
      const result = await registeredSuccessfulSetup(execution, "setup complete");
      await withSystemTx(pool, tx => tx.query(`UPDATE cloud_runtime_qualifications SET enabled=false,mcp_qualified=false,revoked_at=now()
        WHERE runtime_id=$1 AND credential_kind='codex-chatgpt'`, [runtimeWitness.runtimeId]));
      return result;
    }]);
    await worker(executor).runOnce();
    expect((await pool.query("SELECT 1 FROM cloud_workspace_setup_attestations WHERE setup_run_id=$1", [seeded.setupRunId])).rowCount).toBe(0);
    expect((await pool.query("SELECT state,error_code FROM cloud_workspace_setup_runs WHERE id=$1", [seeded.setupRunId])).rows[0])
      .toEqual({ state: "failed", error_code: "cloud_runtime_revoked" });
    expect((await pool.query("SELECT status,last_error_code,last_error_message FROM cloud_workspaces WHERE id=$1", [seeded.workspaceId])).rows[0])
      .toMatchObject({ status: "failed", last_error_code: "cloud_runtime_revoked", last_error_message: expect.stringContaining("upgrade") });
  });

  it("retries a failed setup after an engine identity was already issued", async () => {
    const seeded = await seedSetup();
    const executor = new FakeExecutor([
      async execution => {
        await registeredSuccessfulSetup(execution, "not yet published");
        throw new CloudWorkspaceSetupError("setup_repository_unavailable", "retry fixture", true);
      },
      async execution => registeredSuccessfulSetup(execution, "retried"),
    ]);
    const instance = worker(executor);
    await instance.runOnce();
    await pool.query(`UPDATE cloud_workspace_setup_runs SET next_attempt_at=now() WHERE id=$1`, [seeded.setupRunId]);
    await expect(instance.runOnce()).resolves.toBe(true);
    const engines = await pool.query(`SELECT id,state,setup_execution_fence FROM cloud_workspace_engine_instances
      WHERE workspace_id=$1 ORDER BY setup_execution_fence`, [seeded.workspaceId]);
    expect(engines.rows.map(({ state, setup_execution_fence }) => ({ state, setup_execution_fence }))).toEqual([
      { state: "revoked", setup_execution_fence: "1" }, { state: "ready", setup_execution_fence: "2" },
    ]);
    await expect(pool.query(`UPDATE cloud_workspace_engine_instances SET state='ready',revoked_at=NULL,
      last_heartbeat_at=now(),lease_expires_at=now()+interval '1 minute' WHERE id=$1`, [engines.rows[0].id])).rejects.toMatchObject({ code: "23514" });
  });

  it("stops even when an executor ignores its abort signal", async () => {
    await seedSetup();
    const entered = new Deferred<void>();
    const executor = new FakeExecutor([
      async () => {
        entered.resolve();
        return new Promise<CloudWorkspaceSetupResult>(() => undefined);
      },
    ]);
    const setupWorker = worker(executor);
    const stop = setupWorker.start();
    await entered.promise;

    const outcome = await Promise.race([
      stop().then(() => "stopped" as const),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 250).unref();
      }),
    ]);

    expect(outcome).toBe("stopped");
  });

  it("heartbeats an active execution so another worker cannot reclaim it", async () => {
    const seeded = await seedSetup();
    const entered = new Deferred<void>();
    const release = new Deferred<CloudWorkspaceSetupResult>();
    let claimed!: CloudWorkspaceSetupExecution;
    const executor = new FakeExecutor([
      async (execution) => {
        claimed = execution;
        entered.resolve();
        return release.promise;
      },
    ]);
    const active = worker(executor, {
      workerId: "heartbeat-owner",
      leaseMs: 1_000,
      heartbeatMs: 250,
    }).runOnce();
    await entered.promise;
    const initial = await pool.query<{ lease_expires_at: Date }>(
      `SELECT lease_expires_at FROM cloud_workspace_setup_runs WHERE id = $1`,
      [seeded.setupRunId],
    );
    const initialExpiry = initial.rows[0]!.lease_expires_at.getTime();

    let renewedExpiry = initialExpiry;
    const deadline = Date.now() + 2_000;
    while (renewedExpiry <= initialExpiry && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const renewed = await pool.query<{ lease_expires_at: Date }>(
        `SELECT lease_expires_at
         FROM cloud_workspace_setup_runs WHERE id = $1`,
        [seeded.setupRunId],
      );
      renewedExpiry = renewed.rows[0]!.lease_expires_at.getTime();
    }
    expect(renewedExpiry).toBeGreaterThan(initialExpiry);

    const contender = new FakeExecutor([
      async (execution) => successfulSetup(execution, "must not run"),
    ]);
    await expect(
      worker(contender, { workerId: "heartbeat-contender" }).runOnce(),
    ).resolves.toBe(false);
    expect(contender.calls).toHaveLength(0);

    release.resolve(
      await registeredSuccessfulSetup(claimed, "heartbeat complete"),
    );
    await expect(active).resolves.toBe(true);
  });

  it("executes outside its claim transaction and publishes the immutable setup specification", async () => {
    const seeded = await seedSetup();
    const entered = new Deferred<void>();
    const release = new Deferred<CloudWorkspaceSetupResult>();
    let claimed!: CloudWorkspaceSetupExecution;
    const executor = new FakeExecutor([
      async (execution) => {
        claimed = execution;
        entered.resolve();
        return release.promise;
      },
    ]);
    const running = worker(executor).runOnce();
    await entered.promise;

    await expect(
      withSystemTx(pool, async (tx) => {
        await tx.query("SET LOCAL lock_timeout = '500ms'");
        await tx.query(
          `SELECT id FROM cloud_workspaces WHERE id = $1 FOR UPDATE`,
          [seeded.workspaceId],
        );
      }),
    ).resolves.toBeUndefined();

    expect(executor.calls[0]).toMatchObject({
      setupRunId: seeded.setupRunId,
      workspaceId: seeded.workspaceId,
      authority: { accountUserId: ownerId },
      generation: 1,
      attempt: 1,
      executionFence: 1,
      provider: {
        name: "boat",
        resourceId: `sandbox-${seeded.workspaceId}`,
      },
      image: {
        ref: `boat-template:zeros-v2-test-template-${seeded.workspaceId}-1`,
        sourceCommit: runtimeBase.sourceCommit,
      },
      repository: {
        forge: "github.com",
        owner: "withso",
        name: "zeros",
        revision: "main",
        githubInstallationId: null,
      },
      settings: { version: 1, snapshot: seeded.settingsSnapshot },
    });
    expect(executor.calls[0]!.settings.sha256).toMatch(/^[a-f0-9]{64}$/);

    release.resolve(
      await registeredSuccessfulSetup(claimed, "setup complete secret-value"),
    );
    await expect(running).resolves.toBe(true);
    const stored = await pool.query(
      `SELECT cw.status, sr.state, sr.claim_count, sr.execution_fence,
              sr.lease_owner, sr.lease_expires_at, sr.log_excerpt,
              sa.repository_commit, sa.engine_protocol_version,
              sa.durable_record_connected
       FROM cloud_workspaces cw
       JOIN cloud_workspace_setup_runs sr ON sr.workspace_id = cw.id
       JOIN cloud_workspace_setup_attestations sa ON sa.setup_run_id = sr.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(stored.rows[0]).toEqual({
      status: "ready",
      state: "succeeded",
      claim_count: 1,
      execution_fence: "1",
      lease_owner: null,
      lease_expires_at: null,
      log_excerpt: "setup complete [redacted]",
      repository_commit: "c".repeat(40),
      engine_protocol_version: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
      durable_record_connected: true,
    });
  });

  it("records a fresh readiness attestation for a later verification of the same generation", async () => {
    const seeded = await seedSetup();
    const executor = new FakeExecutor([
      async (execution) =>
        registeredSuccessfulSetup(execution, "initial setup"),
      async (execution) =>
        registeredSuccessfulSetup(execution, "wake verification"),
    ]);
    const setupWorker = worker(executor);

    await expect(setupWorker.runOnce()).resolves.toBe(true);
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `SELECT id FROM cloud_workspaces WHERE id = $1 FOR UPDATE`,
        [seeded.workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET status = 'setting_up', updated_at = now()
         WHERE id = $1`,
        [seeded.workspaceId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_setup_runs (
           workspace_id, generation, org_id, attempt
         ) VALUES ($1, 1, $2, 2)`,
        [seeded.workspaceId, organizationId],
      );
    });

    await expect(setupWorker.runOnce()).resolves.toBe(true);
    const stored = await pool.query(
      `SELECT sr.attempt, sr.execution_fence, sr.state,
              sa.setup_run_id IS NOT NULL AS attested
       FROM cloud_workspace_setup_runs sr
       LEFT JOIN cloud_workspace_setup_attestations sa
         ON sa.setup_run_id = sr.id
       WHERE sr.workspace_id = $1
       ORDER BY sr.attempt`,
      [seeded.workspaceId],
    );
    expect(stored.rows).toEqual([
      {
        attempt: 1,
        execution_fence: "1",
        state: "succeeded",
        attested: true,
      },
      {
        attempt: 2,
        execution_fence: "1",
        state: "succeeded",
        attested: true,
      },
    ]);
  });

  it("fences a late result after another worker reclaims an expired lease", async () => {
    const seeded = await seedSetup();
    const firstEntered = new Deferred<void>();
    const firstRelease = new Deferred<CloudWorkspaceSetupResult>();
    let firstClaim!: CloudWorkspaceSetupExecution;
    const firstExecutor = new FakeExecutor([
      async (execution) => {
        firstClaim = execution;
        firstEntered.resolve();
        return firstRelease.promise;
      },
    ]);
    const firstRun = worker(firstExecutor, {
      workerId: "worker-one",
    }).runOnce();
    await firstEntered.promise;
    await pool.query(
      `UPDATE cloud_workspace_setup_runs
       SET lease_expires_at = now() - interval '1 second',
           last_heartbeat_at = now() - interval '2 seconds'
       WHERE id = $1`,
      [seeded.setupRunId],
    );

    const winnerTimings = { version: 1 as const, clocks: [{ source: "setup" as const, clockId: randomUUID(), startedAt: "2026-10-06T00:00:00.000Z",
      spans: [{ stage: "repository" as const, startMs: 0, endMs: 10, outcome: "passed" as const }] }] };
    const loserTimings = { ...winnerTimings, clocks: [{ ...winnerTimings.clocks[0]!, clockId: randomUUID() }] };
    await pool.query("UPDATE cloud_workspace_setup_runs SET stage_timings=$2 WHERE id=$1", [seeded.setupRunId, loserTimings]);
    const secondExecutor = new FakeExecutor([
      async (execution) => {
        expect((await pool.query("SELECT stage_timings FROM cloud_workspace_setup_runs WHERE id=$1", [seeded.setupRunId])).rows[0].stage_timings).toBeNull();
        return { ...await registeredSuccessfulSetup(execution, "winner"), timings: winnerTimings };
      },
    ]);
    await expect(
      worker(secondExecutor, { workerId: "worker-two" }).runOnce(),
    ).resolves.toBe(true);
    firstRelease.resolve({ ...successfulSetup(firstClaim, "late loser"), timings: loserTimings });
    await expect(firstRun).resolves.toBe(true);

    const stored = await pool.query(
      `SELECT cw.status, sr.state, sr.claim_count, sr.execution_fence,
              sr.log_excerpt, sr.stage_timings
       FROM cloud_workspaces cw
       JOIN cloud_workspace_setup_runs sr ON sr.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(stored.rows[0]).toEqual({
      status: "ready",
      state: "succeeded",
      claim_count: 2,
      execution_fence: "2",
      log_excerpt: "winner",
      stage_timings: winnerTimings,
    });
  });

  it("cannot publish after its lease expires even before another worker reclaims it", async () => {
    const seeded = await seedSetup();
    const entered = new Deferred<void>();
    const release = new Deferred<CloudWorkspaceSetupResult>();
    let claimed!: CloudWorkspaceSetupExecution;
    const executor = new FakeExecutor([
      async (execution) => {
        claimed = execution;
        entered.resolve();
        return release.promise;
      },
    ]);
    const running = worker(executor, {
      workerId: "expired-result-owner",
    }).runOnce();
    await entered.promise;
    await pool.query(
      `UPDATE cloud_workspace_setup_runs
       SET lease_expires_at = now() - interval '1 second',
           last_heartbeat_at = now() - interval '2 seconds'
       WHERE id = $1`,
      [seeded.setupRunId],
    );

    release.resolve(successfulSetup(claimed, "expired result"));
    await expect(running).resolves.toBe(true);

    const stored = await pool.query(
      `SELECT cw.status, sr.state,
              sr.lease_expires_at <= now() AS lease_expired,
              (SELECT count(*) FROM cloud_workspace_setup_attestations sa
               WHERE sa.setup_run_id = sr.id) AS attestation_count
       FROM cloud_workspaces cw
       JOIN cloud_workspace_setup_runs sr ON sr.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(stored.rows[0]).toEqual({
      status: "setting_up",
      state: "running",
      lease_expired: true,
      attestation_count: "0",
    });
  });

  it("cannot publish readiness from an engine revoked by membership loss", async () => {
    const seeded = await seedSetup();
    const entered = new Deferred<void>();
    const release = new Deferred<CloudWorkspaceSetupResult>();
    let claimed!: CloudWorkspaceSetupExecution;
    const executor = new FakeExecutor([
      async (execution) => {
        claimed = execution;
        entered.resolve();
        return release.promise;
      },
    ]);
    const running = worker(executor).runOnce();
    await entered.promise;

    const result = await registeredSuccessfulSetup(
      claimed,
      "revoked readiness must not publish",
    );
    await withSystemTx(pool, (tx) =>
      tx.query(
        `DELETE FROM team_members
         WHERE team_id = $1 AND org_id = $2 AND user_id = $3`,
        [teamId, organizationId, ownerId],
      ),
    );
    release.resolve(result);
    await expect(running).resolves.toBe(true);

    const stored = await pool.query(
      `SELECT cw.status, sr.state, sr.error_code, ei.state AS engine_state,
              (SELECT count(*) FROM cloud_workspace_setup_attestations sa
               WHERE sa.setup_run_id = sr.id) AS attestation_count
       FROM cloud_workspaces cw
       JOIN cloud_workspace_setup_runs sr ON sr.workspace_id = cw.id
       JOIN cloud_workspace_engine_instances ei
         ON ei.workspace_id = cw.id AND ei.generation = cw.current_generation
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(stored.rows[0]).toEqual({
      status: "setting_up",
      state: "cancelled",
      error_code: "setup_publish_ineligible",
      engine_state: "revoked",
      attestation_count: "0",
    });
  });

  it("publishes without deadlocking membership retirement on grant and engine locks", async () => {
    await seedSetup();
    let releaseEngineLock!: () => void;
    let reportEngineLock!: () => void;
    const engineLockHeld = new Promise<void>((resolve) => {
      reportEngineLock = resolve;
    });
    const allowPublicationToContinue = new Promise<void>((resolve) => {
      releaseEngineLock = resolve;
    });
    let intercepted = false;
    const racingPool = {
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query") {
              return async (...args: unknown[]) => {
                const result = await (
                  target.query as (...queryArgs: unknown[]) => Promise<unknown>
                ).apply(target, args);
                const sql = typeof args[0] === "string" ? args[0] : "";
                if (/^BEGIN(?:;|$)/.test(sql)) {
                  await target.query("SET LOCAL statement_timeout = '750ms'");
                }
                if (
                  !intercepted &&
                  sql.includes("FROM cloud_workspace_engine_instances ei") &&
                  sql.includes("ei.protocol_version") &&
                  sql.includes("FOR UPDATE OF ei")
                ) {
                  intercepted = true;
                  reportEngineLock();
                  await allowPublicationToContinue;
                }
                return result;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as pg.Pool;
    const executor = new FakeExecutor([
      (execution) =>
        registeredSuccessfulSetup(
          execution,
          "concurrent membership retirement",
        ),
    ]);
    const publication = worker(executor, { pool: racingPool }).runOnce();
    const membershipOwner = await pool.connect();
    let removal: ReturnType<typeof membershipOwner.query> | null = null;
    try {
      await engineLockHeld;
      const backend = await membershipOwner.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      removal = membershipOwner.query(
        `DELETE FROM team_members
         WHERE team_id = $1 AND org_id = $2 AND user_id = $3`,
        [teamId, organizationId, ownerId],
      );
      await vi.waitFor(
        async () => {
          const waiting = await pool.query<{ wait_event_type: string | null }>(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [backend.rows[0]!.pid],
          );
          expect(waiting.rows[0]?.wait_event_type).toBe("Lock");
        },
        { timeout: 2_000, interval: 20 },
      );
      releaseEngineLock();

      await expect(publication).resolves.toBe(true);
      await removal;
    } finally {
      releaseEngineLock();
      if (removal) await removal.catch(() => undefined);
      membershipOwner.release();
    }

    await expect(
      pool.query<{ setup_state: string; engine_state: string }>(
        `SELECT sr.state AS setup_state, ei.state AS engine_state
         FROM cloud_workspace_setup_runs sr
         JOIN cloud_workspace_engine_instances ei
           ON ei.setup_run_id = sr.id
         WHERE sr.workspace_id = $1`,
        [executor.calls[0]!.workspaceId],
      ),
    ).resolves.toMatchObject({
      rows: [{ setup_state: "succeeded", engine_state: "revoked" }],
    });
  });

  it("retries a safe failure without persisting the executor's raw error", async () => {
    const seeded = await seedSetup();
    const executor = new FakeExecutor([
      async () => {
        throw new CloudWorkspaceSetupError(
          "setup_command_failed",
          "secret-value from provider",
          true,
        );
      },
      async (execution) => registeredSuccessfulSetup(execution, "recovered"),
    ]);
    const setupWorker = worker(executor);

    await expect(setupWorker.runOnce()).resolves.toBe(true);
    let stored = await pool.query(
      `SELECT cw.status, cw.last_error_message, sr.state, sr.claim_count,
              sr.error_code, sr.completed_at, sr.next_attempt_at > now() AS delayed
       FROM cloud_workspaces cw
       JOIN cloud_workspace_setup_runs sr ON sr.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(stored.rows[0]).toEqual({
      status: "setting_up",
      last_error_message: null,
      state: "queued",
      claim_count: 1,
      error_code: "setup_command_failed",
      completed_at: null,
      delayed: true,
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain("secret-value");

    await pool.query(
      `UPDATE cloud_workspace_setup_runs SET next_attempt_at = now()
       WHERE id = $1`,
      [seeded.setupRunId],
    );
    await expect(setupWorker.runOnce()).resolves.toBe(true);
    stored = await pool.query(
      `SELECT cw.status, sr.state, sr.claim_count, sr.execution_fence
       FROM cloud_workspaces cw
       JOIN cloud_workspace_setup_runs sr ON sr.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(stored.rows[0]).toEqual({
      status: "ready",
      state: "succeeded",
      claim_count: 2,
      execution_fence: "2",
    });
  });

  it("records a v4 hook failure log without requeueing or publishing Ready", async () => {
    const seeded=await seedSetup({v4:true});
    const secret="synthetic-private-setup-value";
    const hookLog=redactCloudWorkspaceSetupHookLog(`Hook failed: synthetic-\x1b[31mprivate-setup-value\x1b[0m\n`,[secret]);
    const executor=new FakeExecutor([async()=>{throw Object.assign(new CloudWorkspaceSetupError("setup_command_failed","private executor detail",false),{hookLog});}]);
    const setupWorker=worker(executor);
    expect(await setupWorker.runOnce()).toBe(true);
    const stored=(await pool.query(`SELECT workspace.status,run.state,run.claim_count,run.log_excerpt,run.log_truncated
      FROM cloud_workspaces workspace JOIN cloud_workspace_setup_runs run ON run.workspace_id=workspace.id WHERE workspace.id=$1`,[seeded.workspaceId])).rows[0];
    expect(stored).toMatchObject({status:"failed",state:"failed",claim_count:1,log_excerpt:hookLog.text,log_truncated:false});
    expect(stored.log_excerpt).toBe("Hook failed: [redacted]\n");
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(await setupWorker.runOnce()).toBe(false);
    expect(JSON.stringify(stored)).not.toContain("private executor detail");
  });

  it("rolls a rejected candidate back to its source generation and queues fenced cleanup", async () => {
    const seeded = await seedReplacementSetup();
    const executor = new FakeExecutor([
      async () => {
        throw new CloudWorkspaceSetupError(
          "setup_candidate_rejected",
          "candidate contained unsafe private detail",
          false,
        );
      },
    ]);

    await expect(worker(executor).runOnce()).resolves.toBe(true);
    const stored = await pool.query(
      `SELECT cw.current_generation, cw.status, cw.last_error_code,
              gt.state AS transition_state, gt.error_code,
              gt.completed_at,
              candidate.retired_at IS NOT NULL AS candidate_retired,
              sr.state AS setup_state,
              array_agg(
                jsonb_build_object(
                  'operation', i.operation,
                  'generation', i.generation,
                  'affectsWorkspace', i.affects_workspace,
                  'state', i.state
                ) ORDER BY i.affects_workspace DESC, i.operation
              ) FILTER (WHERE i.id <> gt.provision_intent_id) AS recovery_intents
       FROM cloud_workspaces cw
       JOIN cloud_workspace_generation_transitions gt
         ON gt.workspace_id = cw.id
       JOIN cloud_workspace_generations candidate
         ON candidate.workspace_id = cw.id AND candidate.generation = 2
       JOIN cloud_workspace_setup_runs sr
         ON sr.workspace_id = cw.id AND sr.generation = 2
       LEFT JOIN cloud_workspace_lifecycle_intents i
         ON i.workspace_id = cw.id
       WHERE cw.id = $1
       GROUP BY cw.current_generation, cw.status, cw.last_error_code,
                gt.state, gt.error_code, gt.completed_at,
                candidate.retired_at, sr.state`,
      [seeded.workspaceId],
    );
    expect(stored.rows[0]).toEqual({
      current_generation: 1,
      status: "waking",
      last_error_code: null,
      transition_state: "rolling_back",
      error_code: "setup_candidate_rejected",
      completed_at: null,
      candidate_retired: true,
      setup_state: "failed",
      recovery_intents: [
        {
          operation: "wake",
          generation: 1,
          affectsWorkspace: true,
          state: "queued",
        },
        {
          operation: "delete",
          generation: 2,
          affectsWorkspace: false,
          state: "queued",
        },
      ],
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain("unsafe private");
  });

  it("retires the displaced provider generation only after candidate readiness", async () => {
    const seeded = await seedReplacementSetup();
    const executor = new FakeExecutor([
      async (execution) =>
        registeredSuccessfulSetup(execution, "candidate qualified"),
    ]);

    await expect(worker(executor).runOnce()).resolves.toBe(true);
    const stored = await pool.query(
      `SELECT cw.current_generation, cw.status,
              gt.state AS transition_state,
              gt.completed_at IS NOT NULL AS transition_completed,
              source.retired_at IS NOT NULL AS source_retired,
              cleanup.operation AS cleanup_operation,
              cleanup.generation AS cleanup_generation,
              cleanup.affects_workspace AS cleanup_affects_workspace,
              cleanup.state AS cleanup_state
       FROM cloud_workspaces cw
       JOIN cloud_workspace_generation_transitions gt
         ON gt.workspace_id = cw.id
       JOIN cloud_workspace_generations source
         ON source.workspace_id = cw.id AND source.generation = 1
       JOIN cloud_workspace_lifecycle_intents cleanup
         ON cleanup.generation_transition_id = gt.id
        AND cleanup.id <> gt.provision_intent_id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(stored.rows[0]).toEqual({
      current_generation: 2,
      status: "ready",
      transition_state: "succeeded",
      transition_completed: true,
      source_retired: true,
      cleanup_operation: "delete",
      cleanup_generation: 1,
      cleanup_affects_workspace: false,
      cleanup_state: "queued",
    });
  });

  it("fails closed when an executor returns a stale readiness proof", async () => {
    const seeded = await seedSetup();
    const executor = new FakeExecutor([
      async (execution) => {
        const result = successfulSetup(execution, "must not publish");
        return {
          ...result,
          readiness: {
            ...result.readiness,
            executionFence: execution.executionFence + 1,
          },
        };
      },
    ]);

    await expect(worker(executor).runOnce()).resolves.toBe(true);
    const stored = await pool.query(
      `SELECT cw.status, cw.last_error_code, sr.state, sr.error_code,
              sr.log_excerpt,
              (SELECT count(*) FROM cloud_workspace_setup_attestations sa
               WHERE sa.setup_run_id = sr.id) AS attestation_count
       FROM cloud_workspaces cw
       JOIN cloud_workspace_setup_runs sr ON sr.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(stored.rows[0]).toEqual({
      status: "failed",
      last_error_code: "setup_readiness_invalid",
      state: "failed",
      error_code: "setup_readiness_invalid",
      log_excerpt: "",
      attestation_count: "0",
    });
  });

  it("cannot publish after lifecycle cancellation retires its lease", async () => {
    const seeded = await seedSetup();
    const entered = new Deferred<void>();
    const release = new Deferred<CloudWorkspaceSetupResult>();
    let claimed!: CloudWorkspaceSetupExecution;
    const executor = new FakeExecutor([
      async (execution) => {
        claimed = execution;
        entered.resolve();
        return release.promise;
      },
    ]);
    const running = worker(executor).runOnce();
    await entered.promise;

    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `SELECT id FROM cloud_workspaces WHERE id = $1 FOR UPDATE`,
        [seeded.workspaceId],
      );
      await retireCloudWorkspaceRuntimeAccess(tx, {
        workspaceId: seeded.workspaceId,
        organizationId,
        generation: 1,
        reason: "workspace_stop_requested",
      });
    });
    release.resolve(successfulSetup(claimed, "must not become ready"));
    await expect(running).resolves.toBe(true);

    const stored = await pool.query(
      `SELECT cw.status, sr.state, sr.error_code, sr.log_excerpt,
              sr.lease_owner, sr.lease_expires_at
       FROM cloud_workspaces cw
       JOIN cloud_workspace_setup_runs sr ON sr.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(stored.rows[0]).toEqual({
      status: "setting_up",
      state: "cancelled",
      error_code: "workspace_stop_requested",
      log_excerpt: "",
      lease_owner: null,
      lease_expires_at: null,
    });
  });

  it("never admits a persistent image mismatch after the bounded retry budget", async () => {
    const seeded = await seedSetup({ claimCount: 2, executionFence: 2 });
    const executor = new FakeExecutor([
      async () => { throw new CloudWorkspaceSetupError("setup_image_contract_invalid", "untrusted diagnostic", true); },
    ]);
    const subject = worker(executor, { maxClaims: 3 });
    await expect(subject.runOnce()).resolves.toBe(true);
    await expect(subject.runOnce()).resolves.toBe(false);
    expect(executor.calls).toHaveLength(1);
    const stored = await pool.query(
      `SELECT cw.status, sr.state, sr.error_code, sr.claim_count, sr.log_excerpt,
              (SELECT count(*) FROM cloud_workspace_setup_attestations sa
               WHERE sa.setup_run_id = sr.id) AS attestation_count
       FROM cloud_workspaces cw
       JOIN cloud_workspace_setup_runs sr ON sr.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(stored.rows[0]).toEqual({ status: "failed", state: "failed",
      error_code: "setup_image_contract_invalid", claim_count: 3, log_excerpt: "", attestation_count: "0" });
  });
  it("never wakes a quarantined recovery source when its replacement fails qualification", async () => {
    const seeded = await seedReplacementSetup();
    await pool.query("UPDATE cloud_workspace_generation_transitions SET operation='recover' WHERE id=$1", [seeded.transitionId]);
    const executor = new FakeExecutor([async () => { throw new CloudWorkspaceSetupError("setup_image_contract_invalid", "untrusted", false); }]);
    await worker(executor).runOnce();
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE id=$1", [seeded.transitionId])).rows[0].state).toBe("rollback_failed");
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='wake'", [seeded.workspaceId])).rows[0].n).toBe(0);
  });

  it("fails an execution whose crash lease exhausted the bounded claim budget", async () => {
    const seeded = await seedSetup({
      state: "running",
      claimCount: 3,
      executionFence: 3,
      leaseOwner: "crashed-worker",
      leaseExpired: true,
    });
    const executor = new FakeExecutor([]);

    await expect(worker(executor, { maxClaims: 3 }).runOnce()).resolves.toBe(
      true,
    );
    expect(executor.calls).toHaveLength(0);
    const stored = await pool.query(
      `SELECT cw.status, cw.last_error_code, cw.last_error_message,
              sr.state, sr.error_code, sr.completed_at IS NOT NULL AS completed,
              sr.lease_owner, sr.lease_expires_at
       FROM cloud_workspaces cw
       JOIN cloud_workspace_setup_runs sr ON sr.workspace_id = cw.id
       WHERE cw.id = $1`,
      [seeded.workspaceId],
    );
    expect(stored.rows[0]).toEqual({
      status: "failed",
      last_error_code: "setup_claims_exhausted",
      last_error_message: "Cloud workspace setup did not complete",
      state: "failed",
      error_code: "setup_claims_exhausted",
      completed: true,
      lease_owner: null,
      lease_expires_at: null,
    });
  });

  it("keeps the generation setup specification immutable", async () => {
    const seeded = await seedSetup();
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          `UPDATE cloud_workspace_setup_specs
           SET repository_revision = 'other'
           WHERE workspace_id = $1`,
          [seeded.workspaceId],
        ),
      ),
    ).rejects.toThrow(/immutable/i);

    const spec = await pool.query<{
      repository_revision: string;
      valid_hash: boolean;
    }>(
      `SELECT repository_revision,
              settings_snapshot_sha256 = digest(settings_snapshot::text, 'sha256')
                AS valid_hash
       FROM cloud_workspace_setup_specs WHERE workspace_id = $1`,
      [seeded.workspaceId],
    );
    expect(spec.rows[0]).toEqual({
      repository_revision: "main",
      valid_hash: true,
    });
    expect(
      createHash("sha256")
        .update(JSON.stringify(seeded.settingsSnapshot))
        .digest("hex"),
    ).toMatch(/^[a-f0-9]{64}$/);
  });
});
