import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import type Database from "better-sqlite3";

import { scanCloudWorkspaceChanges } from "./cloud-durability-runtime";
import {
  assertBootstrapEntryMatchesManifest,
  parseBootstrapManifest,
  type BootstrapManifestBinding,
} from "./cloud-replica-broker";
import {
  CloudReplicaClientError,
  type CloudWorkspaceDesktopApi,
  type CloudWorkspaceForkManifestPage,
  type CloudWorkspaceForkRecordPage,
} from "./cloud-replica-client";
import {
  DatabaseCloudWorkspaceForkState,
  type CloudWorkspaceForkJob,
  type CloudWorkspaceForkJobEntry,
} from "./cloud-workspace-fork-state";
import {
  materializeCloudWorkspaceFork,
  collectCloudWorkspaceForkStages,
  readCloudWorkspaceForkBlob,
  removeCloudWorkspaceForkStage,
  stageCloudWorkspaceForkBlob,
} from "./cloud-workspace-fork-stage";
import {
  cloudWorkspaceForkSnapshotSha256,
  exportCloudWorkspaceForkRecords,
  importCloudWorkspaceForkRecords,
  type CloudWorkspaceForkRecord,
  type CloudWorkspaceForkRecordEvent,
} from "./cloud-workspace-fork-records";
import { isKnownRepoRoot } from "./db/projects";
import { parseGitHubRemote } from "./git/github";
import { isRepo, readOriginUrl } from "./git/repo";
import { getWorkspaceByCanonicalId, getWorkspaceById } from "./git/state";
import {
  createWorkspace,
  isPreparedWorkspaceCreateIdentity,
  prepareWorkspaceCreate,
} from "./git/worktree";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FULL_COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_ENTRIES = 100_000;
const MAX_RECORDS = 250_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const SCHEDULER_INTERVAL_MS = 15_000;
const MAX_RETRY_MS = 5 * 60_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXPORT_MANIFEST_AUDIENCE = "zeros-cloud-to-local-fork-v1";

class CloudWorkspaceForkCancelledError extends Error {
  constructor() {
    super("Cloud workspace copy was cancelled");
    this.name = "CloudWorkspaceForkCancelledError";
  }
}

type DesktopContext = {
  accountUserId: string;
  api: CloudWorkspaceDesktopApi;
};

export type LocalToCloudCopyInput = {
  sourceWorkspaceAlias: string;
  organizationId: string;
  name?: string;
  teamId?: string;
  repository: {
    forge: "github.com";
    owner: string;
    name: string;
    revision: string;
    githubInstallationId: string;
  };
  includeChats?: boolean;
  includeSettings?: boolean;
};

export type CloudToLocalCopyInput = {
  organizationId: string;
  sourceWorkspaceId: string;
  repoRoot: string;
  includeChats?: boolean;
};

type LocalRequest = {
  version: 1;
  kind: "local_to_cloud";
  occurredAt: string;
  name?: string;
  teamId?: string;
  repository: LocalToCloudCopyInput["repository"];
  includeChats: boolean;
  includeSettings: boolean;
};

type CloudRequest = {
  version: 1;
  kind: "cloud_to_local";
  includeChats: boolean;
  prepared?: {
    workspaceId: string;
    branch: string;
    repoSlug: string;
  };
};

type ExportManifest = Omit<
  CloudWorkspaceForkManifestPage,
  "entries" | "nextAfterPath"
>;

export class CloudWorkspaceForkRuntimeError extends Error {
  constructor(
    public readonly code: string,
    public readonly jobId: string | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CloudWorkspaceForkRuntimeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validGithubName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 100 &&
    /^[A-Za-z0-9_.-]+$/.test(value)
  );
}

function validGitRevision(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    return false;
  }
  if (FULL_COMMIT_PATTERN.test(value)) return true;
  if (
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character);
    })
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (component) =>
        component.length > 0 &&
        !component.startsWith(".") &&
        !component.endsWith(".lock"),
    );
}

function portablePathKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function asLocalRequest(job: CloudWorkspaceForkJob): LocalRequest {
  const value = job.request;
  if (
    value.version !== 1 ||
    value.kind !== "local_to_cloud" ||
    typeof value.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(value.occurredAt)) ||
    typeof value.includeChats !== "boolean" ||
    typeof value.includeSettings !== "boolean" ||
    !isRecord(value.repository) ||
    value.repository.forge !== "github.com" ||
    !validGithubName(value.repository.owner) ||
    !validGithubName(value.repository.name) ||
    !validGitRevision(value.repository.revision) ||
    typeof value.repository.githubInstallationId !== "string" ||
    !UUID_PATTERN.test(value.repository.githubInstallationId) ||
    (value.name !== undefined &&
      (typeof value.name !== "string" ||
        value.name.trim() !== value.name ||
        value.name.length < 1 ||
        value.name.length > 120)) ||
    (value.teamId !== undefined &&
      (typeof value.teamId !== "string" || !UUID_PATTERN.test(value.teamId)))
  ) {
    throw new Error("Local-to-cloud copy request is corrupt");
  }
  return value as unknown as LocalRequest;
}

function asCloudRequest(job: CloudWorkspaceForkJob): CloudRequest {
  const value = job.request;
  if (
    value.version !== 1 ||
    value.kind !== "cloud_to_local" ||
    typeof value.includeChats !== "boolean" ||
    (value.prepared !== undefined &&
      (!isRecord(value.prepared) ||
        typeof value.prepared.workspaceId !== "string" ||
        typeof value.prepared.branch !== "string" ||
        typeof value.prepared.repoSlug !== "string" ||
        !isPreparedWorkspaceCreateIdentity({
          workspaceId: value.prepared.workspaceId,
          branch: value.prepared.branch,
          repoSlug: value.prepared.repoSlug,
        })))
  ) {
    throw new Error("Cloud-to-local copy request is corrupt");
  }
  return value as unknown as CloudRequest;
}

function manifestDocument(
  page: CloudWorkspaceForkManifestPage,
): ExportManifest {
  const { entries: _entries, nextAfterPath: _cursor, ...manifest } = page;
  return manifest;
}

function sameManifest(left: ExportManifest, right: ExportManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function remoteProtocolError(
  jobId: string,
  message: string,
  cause?: unknown,
): CloudWorkspaceForkRuntimeError {
  return new CloudWorkspaceForkRuntimeError(
    "remote_protocol_error",
    jobId,
    message,
    {
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/** Validate the immutable descriptor written by the export worker. This is a
 * separate canonical document from a checkpoint projection manifest: its hash
 * pins export identity/revisions/totals, while the checkpoint manifest binds
 * every path and mode. Never compare either remote hash to the locally
 * materialized DatabaseCloudReplicaState.manifestSha256, whose canonical form
 * intentionally differs. */
function assertCanonicalExportManifest(input: {
  bytes: Uint8Array;
  sha256: string;
  job: CloudWorkspaceForkJob;
  page: CloudWorkspaceForkManifestPage;
}): void {
  if (
    !SHA256_PATTERN.test(input.sha256) ||
    createHash("sha256").update(input.bytes).digest("hex") !== input.sha256
  ) {
    throw remoteProtocolError(
      input.job.jobId,
      "Cloud canonical export manifest integrity is invalid",
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.bytes),
    ) as unknown;
  } catch (error) {
    throw remoteProtocolError(
      input.job.jobId,
      "Cloud canonical export manifest is unreadable",
      error,
    );
  }
  if (!isRecord(document)) {
    throw remoteProtocolError(
      input.job.jobId,
      "Cloud canonical export manifest is invalid",
    );
  }
  const expected = {
    audience: EXPORT_MANIFEST_AUDIENCE,
    forkIntentId: input.job.remoteForkIntentId,
    sourceCloudWorkspaceId: input.job.sourceWorkspaceId,
    targetLocalWorkspaceId: input.job.targetWorkspaceId,
    checkpointId: input.page.checkpointId,
    contentRevision: input.page.contentRevision,
    recordRevision: input.page.recordRevision,
    includeChats: input.page.includeChats,
    fileCount: input.page.fileCount,
    totalBytes: input.page.totalBytes,
  };
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(document).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some(
      (key) => document[key] !== expected[key as keyof typeof expected],
    )
  ) {
    throw remoteProtocolError(
      input.job.jobId,
      "Cloud canonical export manifest does not bind this fork",
    );
  }
  let canonical: Buffer | undefined;
  try {
    canonical = Buffer.from(canonicalJson(document), "utf8");
    if (!canonical.equals(Buffer.from(input.bytes))) {
      throw remoteProtocolError(
        input.job.jobId,
        "Cloud canonical export manifest is not canonical",
      );
    }
  } finally {
    canonical?.fill(0);
  }
}

function runtimeCode(error: unknown): string {
  if (error instanceof CloudReplicaClientError) return error.code;
  if (error instanceof CloudWorkspaceForkRuntimeError) return error.code;
  return error instanceof Error
    ? error.name.replace(/[^a-z0-9_.-]/gi, "_").toLowerCase()
    : "unknown_error";
}

function runtimeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Cloud workspace copy failed";
}

/** Server validation, identity, and immutable source conflicts cannot improve
 * with a retry. Network, export-readiness, and short-lived grant failures are
 * intentionally left resumable. */
export function isPermanentCloudWorkspaceForkFailure(error: unknown): boolean {
  const code = runtimeCode(error);
  return new Set([
    "invalid_request",
    "identity_mismatch",
    "not_found",
    "forbidden",
    "cloud_workspace_scope_not_found",
    "cloud_workspace_owner_required",
    "cloud_workspaces_not_allowed",
    "cloud_account_entitlement_required",
    "cloud_organization_entitlement_required",
    "workspace_fork_not_found",
    "workspace_fork_idempotency_conflict",
    "workspace_fork_import_conflict",
    "workspace_fork_device_proof_rejected",
    "workspace_fork_device_proof_replayed",
    "workspace_fork_blob_unavailable",
    "invalid_response",
    "remote_protocol_error",
  ]).has(code);
}

function entryDocument(entry: CloudWorkspaceForkJobEntry) {
  return entry.operation === "delete"
    ? { operation: "delete" as const, path: entry.path }
    : {
        operation: "upsert" as const,
        path: entry.path,
        entryType: entry.entryType,
        mode: entry.mode,
        blobId: entry.remoteBlobId!,
        contentSha256: entry.contentSha256,
        sizeBytes: entry.sizeBytes,
      };
}

function delayForAttempt(attemptCount: number): number {
  return Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(attemptCount, 8));
}

/** Desktop-only coordinator for copy/fork workflows. It never changes source
 * authority: each direction creates a distinct UUID and leaves the source in
 * place. All remote authorization is delegated to the current WorkOS/device-
 * proof HTTP client; only sanitized progress and staged content are durable. */
export class CloudWorkspaceForkRuntime {
  private readonly state: DatabaseCloudWorkspaceForkState;
  private readonly now: () => number;
  private readonly active = new Map<string, Promise<CloudWorkspaceForkJob>>();
  private readonly activeControllers = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    db: Database.Database,
    private readonly dependencies: {
      context: () => DesktopContext;
      now?: () => number;
      logger?: Pick<Console, "warn">;
      schedulerIntervalMs?: number;
      prepareWorkspaceCreate?: typeof prepareWorkspaceCreate;
      createWorkspace?: typeof createWorkspace;
      validateRepository?: (
        job: CloudWorkspaceForkJob,
        manifest: ExportManifest,
      ) => Promise<void>;
    },
  ) {
    this.state = new DatabaseCloudWorkspaceForkState(db);
    this.now = dependencies.now ?? Date.now;
    const interval = dependencies.schedulerIntervalMs ?? SCHEDULER_INTERVAL_MS;
    if (
      !Number.isSafeInteger(interval) ||
      interval < 1_000 ||
      interval > 300_000
    ) {
      throw new Error("Cloud copy scheduler interval is invalid");
    }
    void this.collectStagedData().catch((error) => {
      this.dependencies.logger?.warn(
        `[cloud-fork] staged-data cleanup deferred (${runtimeCode(error)})`,
      );
    });
  }

  private async collectStagedData(): Promise<void> {
    await collectCloudWorkspaceForkStages({
      retainJobIds: new Set(this.state.resumableStageJobIds()),
    });
  }

  private assertJobActive(jobId: string): void {
    const job = this.state.job(jobId);
    if (
      this.disposed ||
      this.activeControllers.get(jobId)?.signal.aborted ||
      job?.state === "cancelled"
    ) {
      throw new CloudWorkspaceForkCancelledError();
    }
  }

  private async cleanupStage(jobId: string): Promise<void> {
    try {
      await removeCloudWorkspaceForkStage(jobId);
    } catch (error) {
      // The terminal journal prevents retrying remote side effects. Startup GC
      // will make a second safe attempt if a local AV/filesystem race wins.
      this.dependencies.logger?.warn(
        `[cloud-fork] staged-data cleanup deferred (${runtimeCode(error)})`,
      );
    }
  }

  private schedule(delay: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick()
        .catch((error) => {
          this.dependencies.logger?.warn(
            `[cloud-fork] scheduler failed (${runtimeCode(error)})`,
          );
        })
        .finally(() => {
          this.schedule(
            this.dependencies.schedulerIntervalMs ?? SCHEDULER_INTERVAL_MS,
          );
        })
        .catch((error) => {
          this.dependencies.logger?.warn(
            `[cloud-fork] scheduler reschedule failed (${runtimeCode(error)})`,
          );
        });
    }, delay);
    this.timer.unref?.();
  }

  wake(): void {
    this.schedule(0);
  }

  list(): CloudWorkspaceForkJob[] {
    let accountUserId: string;
    try {
      accountUserId = this.dependencies.context().accountUserId;
    } catch {
      return [];
    }
    return this.state.jobs(accountUserId);
  }

  async copyLocalToCloud(
    input: LocalToCloudCopyInput,
  ): Promise<CloudWorkspaceForkJob> {
    const context = this.dependencies.context();
    const source = getWorkspaceById(input.sourceWorkspaceAlias);
    const name = input.name?.trim();
    if (
      !source?.canonicalId ||
      source.placement === "cloud" ||
      !UUID_PATTERN.test(source.canonicalId) ||
      !UUID_PATTERN.test(input.organizationId) ||
      input.repository.forge !== "github.com" ||
      !validGithubName(input.repository.owner) ||
      !validGithubName(input.repository.name) ||
      !validGitRevision(input.repository.revision) ||
      !UUID_PATTERN.test(input.repository.githubInstallationId) ||
      (name !== undefined && (name.length < 1 || name.length > 120)) ||
      (input.teamId !== undefined && !UUID_PATTERN.test(input.teamId))
    ) {
      throw new CloudWorkspaceForkRuntimeError(
        "invalid_request",
        null,
        "Local-to-cloud copy input is invalid",
      );
    }
    const sourcePath = await realpath(source.path).catch(() => null);
    if (
      sourcePath !== source.path ||
      !(await lstat(source.path)).isDirectory()
    ) {
      throw new CloudWorkspaceForkRuntimeError(
        "invalid_request",
        null,
        "Local workspace checkout is unavailable",
      );
    }
    const jobId = randomUUID();
    const targetWorkspaceId = randomUUID();
    this.state.create({
      jobId,
      operation: "local_to_cloud",
      accountUserId: context.accountUserId,
      organizationId: input.organizationId,
      sourceWorkspaceId: source.canonicalId,
      targetWorkspaceId,
      sourceWorkspaceAlias: source.id,
      repoRoot: source.path,
      request: {
        version: 1,
        kind: "local_to_cloud",
        occurredAt: new Date(this.now()).toISOString(),
        ...(name === undefined ? {} : { name }),
        ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
        repository: input.repository,
        includeChats: input.includeChats !== false,
        includeSettings: input.includeSettings !== false,
      },
      now: this.now(),
    });
    return this.run(jobId);
  }

  async copyCloudToLocal(
    input: CloudToLocalCopyInput,
  ): Promise<CloudWorkspaceForkJob> {
    const context = this.dependencies.context();
    const root = path.resolve(input.repoRoot);
    if (
      !UUID_PATTERN.test(input.organizationId) ||
      !UUID_PATTERN.test(input.sourceWorkspaceId) ||
      root !== input.repoRoot ||
      root === path.parse(root).root ||
      !isKnownRepoRoot(root) ||
      !(await isRepo(root)) ||
      (await realpath(root).catch(() => null)) !== root
    ) {
      throw new CloudWorkspaceForkRuntimeError(
        "invalid_request",
        null,
        "Cloud-to-local copy input is invalid",
      );
    }
    const jobId = randomUUID();
    this.state.create({
      jobId,
      operation: "cloud_to_local",
      accountUserId: context.accountUserId,
      organizationId: input.organizationId,
      sourceWorkspaceId: input.sourceWorkspaceId,
      targetWorkspaceId: randomUUID(),
      repoRoot: root,
      request: {
        version: 1,
        kind: "cloud_to_local",
        includeChats: input.includeChats !== false,
      },
      now: this.now(),
    });
    return this.run(jobId);
  }

  run(jobId: string): Promise<CloudWorkspaceForkJob> {
    if (!UUID_PATTERN.test(jobId)) {
      return Promise.reject(
        new CloudWorkspaceForkRuntimeError(
          "invalid_request",
          null,
          "Cloud copy job identity is invalid",
        ),
      );
    }
    const existing = this.active.get(jobId);
    if (existing) return existing;
    const controller = new AbortController();
    this.activeControllers.set(jobId, controller);
    const operation = this.runExclusive(jobId).finally(() => {
      if (this.active.get(jobId) === operation) this.active.delete(jobId);
      if (this.activeControllers.get(jobId) === controller) {
        this.activeControllers.delete(jobId);
      }
    });
    this.active.set(jobId, operation);
    return operation;
  }

  async cancel(jobId: string): Promise<CloudWorkspaceForkJob> {
    if (!UUID_PATTERN.test(jobId)) {
      throw new CloudWorkspaceForkRuntimeError(
        "invalid_request",
        null,
        "Cloud copy job identity is invalid",
      );
    }
    const job = this.state.job(jobId);
    if (!job) {
      throw new CloudWorkspaceForkRuntimeError(
        "not_found",
        jobId,
        "Cloud copy job was not found",
      );
    }
    const context = this.dependencies.context();
    if (context.accountUserId !== job.accountUserId) {
      throw new CloudWorkspaceForkRuntimeError(
        "identity_mismatch",
        jobId,
        "Cloud copy job belongs to another account",
      );
    }
    const cancelled = this.state.cancel({
      jobId,
      code: "cancelled_by_user",
      message: "Cloud workspace copy was cancelled",
      now: this.now(),
    });
    this.activeControllers.get(jobId)?.abort();
    await this.active.get(jobId)?.catch(() => undefined);
    await this.cleanupStage(jobId);
    return this.state.job(jobId) ?? cancelled;
  }

  /** Session replacement and shutdown abort only in-memory work. The persisted
   * job remains resumable if the same account returns later. */
  async cancelActiveWork(): Promise<void> {
    for (const controller of this.activeControllers.values())
      controller.abort();
    await Promise.allSettled(this.active.values());
  }

  private async runExclusive(jobId: string): Promise<CloudWorkspaceForkJob> {
    let job = this.state.job(jobId);
    if (!job) {
      throw new CloudWorkspaceForkRuntimeError(
        "not_found",
        jobId,
        "Cloud copy job was not found",
      );
    }
    if (job.state === "succeeded" || job.state === "cancelled") return job;
    try {
      this.assertJobActive(jobId);
      const context = this.dependencies.context();
      if (context.accountUserId !== job.accountUserId) {
        throw new CloudWorkspaceForkRuntimeError(
          "identity_mismatch",
          jobId,
          "Cloud copy job belongs to another account",
        );
      }
      return job.operation === "local_to_cloud"
        ? await this.resumeLocalToCloud(job, context)
        : await this.resumeCloudToLocal(job, context);
    } catch (error) {
      job = this.state.job(jobId) ?? job;
      if (job.state === "succeeded" || job.state === "cancelled") return job;
      if (error instanceof CloudWorkspaceForkCancelledError) return job;
      if (isPermanentCloudWorkspaceForkFailure(error)) {
        const failed = this.state.failPermanent({
          jobId,
          code: runtimeCode(error),
          message: runtimeMessage(error),
          now: this.now(),
        });
        await this.cleanupStage(jobId);
        throw new CloudWorkspaceForkRuntimeError(
          failed.lastErrorCode ?? "permanent.failed",
          jobId,
          failed.lastErrorMessage ?? "Cloud workspace copy failed",
          { cause: error },
        );
      }
      const failed = this.state.fail({
        jobId,
        code: runtimeCode(error),
        message: runtimeMessage(error),
        now: this.now(),
        retryAt: this.now() + delayForAttempt(job.attemptCount),
      });
      throw new CloudWorkspaceForkRuntimeError(
        failed.lastErrorCode ?? "failed",
        jobId,
        failed.lastErrorMessage ?? "Cloud workspace copy failed",
        { cause: error },
      );
    }
  }

  private move(
    job: CloudWorkspaceForkJob,
    to: Parameters<DatabaseCloudWorkspaceForkState["transition"]>[0]["to"],
    patch: Omit<
      Parameters<DatabaseCloudWorkspaceForkState["transition"]>[0],
      "jobId" | "from" | "to" | "now"
    > = {},
  ): CloudWorkspaceForkJob {
    return this.state.transition({
      jobId: job.jobId,
      from: [job.state],
      to,
      now: this.now(),
      ...patch,
    });
  }

  private async snapshotLocal(
    job: CloudWorkspaceForkJob,
  ): Promise<CloudWorkspaceForkJob> {
    this.assertJobActive(job.jobId);
    const request = asLocalRequest(job);
    const source = job.sourceWorkspaceAlias
      ? getWorkspaceById(job.sourceWorkspaceAlias)
      : null;
    if (
      !source ||
      source.canonicalId !== job.sourceWorkspaceId ||
      source.path !== job.repoRoot ||
      source.placement === "cloud"
    ) {
      throw new Error("Local workspace identity changed before snapshot");
    }
    job = this.move(job, "snapshotting");
    const scan = await scanCloudWorkspaceChanges(job.repoRoot, {
      verifyStable: true,
      // This switch applies only to the committed/reviewable repository
      // layer. Device-private settings and secret-like paths are never part of
      // the scan; target cloud settings are independently resolved server-side.
      includeRepositorySettings: request.includeSettings,
    });
    try {
      this.assertJobActive(job.jobId);
      const records = request.includeChats
        ? exportCloudWorkspaceForkRecords({
            sourceRoot: job.repoRoot,
            targetWorkspaceCanonicalId: job.targetWorkspaceId,
            occurredAt: request.occurredAt,
          })
        : [];
      const paths = [
        ...new Set([...scan.entries.keys(), ...scan.deletions]),
      ].sort();
      const entries: CloudWorkspaceForkJobEntry[] = [];
      for (let ordinal = 0; ordinal < paths.length; ordinal += 1) {
        this.assertJobActive(job.jobId);
        const entryPath = paths[ordinal]!;
        const scanned = scan.entries.get(entryPath);
        if (!scanned) {
          entries.push({
            ordinal,
            path: entryPath,
            portablePathKey: portablePathKey(entryPath),
            operation: "delete",
            entryType: null,
            mode: null,
            contentSha256: null,
            sizeBytes: null,
            stageName: null,
            remoteBlobId: null,
          });
          continue;
        }
        const stageName = await stageCloudWorkspaceForkBlob({
          jobId: job.jobId,
          sha256: scanned.contentSha256,
          bytes: scanned.bytes,
        });
        this.assertJobActive(job.jobId);
        entries.push({
          ordinal,
          path: entryPath,
          portablePathKey: portablePathKey(entryPath),
          operation: "upsert",
          entryType: scanned.entryType,
          mode: scanned.mode,
          contentSha256: scanned.contentSha256,
          sizeBytes: scanned.sizeBytes,
          stageName,
          remoteBlobId: null,
        });
      }
      this.state.replacePayload({
        jobId: job.jobId,
        entries,
        records: records as unknown as Record<string, unknown>[],
      });
      this.assertJobActive(job.jobId);
      return this.move(job, "creating_remote", {
        sourceSnapshotSha256: cloudWorkspaceForkSnapshotSha256(
          scan.fingerprint,
          records,
        ),
        sourceRevision: 0,
        manifest: {
          gitBaseCommit: scan.gitBaseCommit,
          gitHeadRef: scan.gitHeadRef,
        },
      });
    } finally {
      for (const entry of scan.entries.values()) entry.bytes.fill(0);
    }
  }

  private async resumeLocalToCloud(
    initial: CloudWorkspaceForkJob,
    context: DesktopContext,
  ): Promise<CloudWorkspaceForkJob> {
    let job = initial;
    this.assertJobActive(job.jobId);
    const request = asLocalRequest(job);
    if (!job.sourceSnapshotSha256) job = await this.snapshotLocal(job);
    this.assertJobActive(job.jobId);
    if (!job.remoteForkIntentId) {
      job = this.move(job, "creating_remote");
      const created = await context.api.createCloudFromLocal({
        organizationId: job.organizationId,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.teamId === undefined ? {} : { teamId: request.teamId }),
        repository: {
          ...request.repository,
          // A copy is anchored to the local checkout's exact HEAD. A mutable
          // branch name could advance between capture and remote clone and
          // would make the staged overlay describe a different repository.
          revision: job.manifest!.gitBaseCommit as string,
        },
        sourceWorkspaceId: job.sourceWorkspaceId,
        targetWorkspaceId: job.targetWorkspaceId,
        sourceRevision: job.sourceRevision ?? 0,
        sourceSnapshotSha256: job.sourceSnapshotSha256!,
        sourceGitHeadRef:
          job.manifest?.gitHeadRef === null ||
          typeof job.manifest?.gitHeadRef === "string"
            ? (job.manifest.gitHeadRef as string | null)
            : null,
        includeChats: request.includeChats,
        includeSettings: request.includeSettings,
        idempotencyKey: `fork.${job.jobId}.create`,
      });
      this.assertJobActive(job.jobId);
      job = this.move(job, "uploading", {
        remoteForkIntentId: created.forkIntentId,
        remoteLifecycleIntentId: created.lifecycleIntentId,
      });
    } else {
      job = this.move(job, "uploading");
    }

    let entries = this.state.entries(job.jobId);
    const byStage = new Map<string, string>();
    for (const entry of entries) {
      this.assertJobActive(job.jobId);
      if (entry.operation !== "upsert") continue;
      const known = entry.remoteBlobId ?? byStage.get(entry.stageName);
      if (known) {
        if (!entry.remoteBlobId)
          this.state.setRemoteBlob(job.jobId, entry.ordinal, known);
        byStage.set(entry.stageName, known);
        continue;
      }
      const bytes = await readCloudWorkspaceForkBlob({
        jobId: job.jobId,
        stageName: entry.stageName,
        sha256: entry.contentSha256,
        sizeBytes: entry.sizeBytes,
      });
      this.assertJobActive(job.jobId);
      try {
        const uploaded = await context.api.uploadForkBlob({
          organizationId: job.organizationId,
          workspaceId: job.targetWorkspaceId,
          forkIntentId: job.remoteForkIntentId!,
          bytes,
        });
        this.assertJobActive(job.jobId);
        this.state.setRemoteBlob(job.jobId, entry.ordinal, uploaded.id);
        byStage.set(entry.stageName, uploaded.id);
      } finally {
        bytes.fill(0);
      }
    }
    entries = this.state.entries(job.jobId);
    for (let offset = 0; offset < entries.length; offset += 1_000) {
      this.assertJobActive(job.jobId);
      const page = entries.slice(offset, offset + 1_000);
      if (
        page.some(
          (entry) => entry.operation === "upsert" && !entry.remoteBlobId,
        )
      ) {
        throw new Error("Cloud copy blob upload is incomplete");
      }
      await context.api.stageForkEntries({
        organizationId: job.organizationId,
        workspaceId: job.targetWorkspaceId,
        forkIntentId: job.remoteForkIntentId!,
        entries: page.map(entryDocument),
      });
      this.assertJobActive(job.jobId);
    }
    const records = this.state.records(
      job.jobId,
    ) as unknown as CloudWorkspaceForkRecord[];
    for (let offset = 0; offset < records.length; offset += 20) {
      this.assertJobActive(job.jobId);
      await context.api.stageForkRecords({
        organizationId: job.organizationId,
        workspaceId: job.targetWorkspaceId,
        forkIntentId: job.remoteForkIntentId!,
        records: records.slice(offset, offset + 20),
      });
      this.assertJobActive(job.jobId);
    }
    job = this.move(job, "finalizing");
    const finalized = await context.api.finalizeForkImport({
      organizationId: job.organizationId,
      workspaceId: job.targetWorkspaceId,
      forkIntentId: job.remoteForkIntentId!,
      idempotencyKey: `fork.${job.jobId}.finalize`,
    });
    this.assertJobActive(job.jobId);
    job = this.move(job, "succeeded", { checkpointId: finalized.checkpointId });
    await this.cleanupStage(job.jobId);
    return job;
  }

  private async exportGrant(
    job: CloudWorkspaceForkJob,
    context: DesktopContext,
  ): Promise<{ token: string; expiresAt: number } | null> {
    this.assertJobActive(job.jobId);
    try {
      const grant = await context.api.issueExportGrant({
        organizationId: job.organizationId,
        workspaceId: job.sourceWorkspaceId,
        forkIntentId: job.remoteForkIntentId!,
      });
      this.assertJobActive(job.jobId);
      return {
        token: grant.grantToken,
        expiresAt: Date.parse(grant.expiresAt),
      };
    } catch (error) {
      if (
        error instanceof CloudReplicaClientError &&
        error.code === "workspace_fork_export_unavailable"
      ) {
        return null;
      }
      throw error;
    }
  }

  private async downloadExport(
    job: CloudWorkspaceForkJob,
    context: DesktopContext,
  ): Promise<{
    manifest: ExportManifest;
    entries: CloudWorkspaceForkJobEntry[];
    records: CloudWorkspaceForkRecordEvent[];
  } | null> {
    let grant = await this.exportGrant(job, context);
    this.assertJobActive(job.jobId);
    if (!grant) return null;
    const withGrant = async <T>(
      operation: (token: string) => Promise<T>,
    ): Promise<T> => {
      if (grant!.expiresAt <= this.now() + 5_000) {
        grant = await this.exportGrant(job, context);
        if (!grant)
          throw new Error("Cloud workspace export became unavailable");
      }
      try {
        const result = await operation(grant!.token);
        this.assertJobActive(job.jobId);
        return result;
      } catch (error) {
        if (
          error instanceof CloudReplicaClientError &&
          error.code === "workspace_fork_grant_rejected"
        ) {
          grant = await this.exportGrant(job, context);
          if (!grant) throw error;
          const result = await operation(grant.token);
          this.assertJobActive(job.jobId);
          return result;
        }
        throw error;
      }
    };

    let afterPath: string | null = null;
    let manifest: ExportManifest | null = null;
    let exportManifestBound = false;
    let checkpointBinding: BootstrapManifestBinding | null = null;
    const entries: CloudWorkspaceForkJobEntry[] = [];
    const seenPaths = new Set<string>();
    const seenPortable = new Set<string>();
    do {
      this.assertJobActive(job.jobId);
      const page = await withGrant((token) =>
        context.api.readForkManifest({
          organizationId: job.organizationId,
          workspaceId: job.sourceWorkspaceId,
          forkIntentId: job.remoteForkIntentId!,
          grantToken: token,
          afterPath,
          limit: 1_000,
        }),
      );
      this.assertJobActive(job.jobId);
      if (page.targetLocalWorkspaceId !== job.targetWorkspaceId) {
        throw remoteProtocolError(
          job.jobId,
          "Cloud export target identity changed",
        );
      }
      const document = manifestDocument(page);
      if (manifest && !sameManifest(manifest, document)) {
        throw remoteProtocolError(
          job.jobId,
          "Cloud export manifest changed during pagination",
        );
      }
      manifest ??= document;
      if (
        (page.exportManifestBlobId === undefined) !==
        (page.exportManifestSha256 === undefined)
      ) {
        throw remoteProtocolError(
          job.jobId,
          "Cloud export canonical manifest advertisement is incomplete",
        );
      }
      if (
        !exportManifestBound &&
        page.exportManifestBlobId &&
        page.exportManifestSha256
      ) {
        const bytes = await withGrant((token) =>
          context.api.readForkBlob({
            organizationId: job.organizationId,
            workspaceId: job.sourceWorkspaceId,
            forkIntentId: job.remoteForkIntentId!,
            grantToken: token,
            blobId: page.exportManifestBlobId!,
          }),
        );
        try {
          assertCanonicalExportManifest({
            bytes,
            sha256: page.exportManifestSha256,
            job,
            page,
          });
          exportManifestBound = true;
        } finally {
          bytes.fill(0);
        }
      }
      if (
        (page.manifestBlobId === undefined) !==
        (page.integritySha256 === undefined)
      ) {
        throw remoteProtocolError(
          job.jobId,
          "Cloud checkpoint manifest advertisement is incomplete",
        );
      }
      if (!checkpointBinding && page.manifestBlobId && page.integritySha256) {
        const bytes = await withGrant((token) =>
          context.api.readForkBlob({
            organizationId: job.organizationId,
            workspaceId: job.sourceWorkspaceId,
            forkIntentId: job.remoteForkIntentId!,
            grantToken: token,
            blobId: page.manifestBlobId!,
          }),
        );
        try {
          try {
            checkpointBinding = parseBootstrapManifest({
              bytes,
              page: {
                integritySha256: page.integritySha256,
                fileCount: page.fileCount,
                totalBytes: page.totalBytes,
                gitBaseCommit: page.gitBaseCommit,
                gitHeadRef: page.gitHeadRef,
              },
            });
          } catch (error) {
            throw remoteProtocolError(
              job.jobId,
              "Cloud checkpoint manifest is invalid",
              error,
            );
          }
        } finally {
          bytes.fill(0);
        }
      }
      for (const candidate of page.entries) {
        this.assertJobActive(job.jobId);
        if (checkpointBinding) {
          try {
            assertBootstrapEntryMatchesManifest(checkpointBinding, candidate);
          } catch (error) {
            throw remoteProtocolError(
              job.jobId,
              "Cloud checkpoint manifest does not match its export page",
              error,
            );
          }
        }
        const portable = portablePathKey(candidate.path);
        if (seenPaths.has(candidate.path) || seenPortable.has(portable)) {
          throw remoteProtocolError(
            job.jobId,
            "Cloud export contains colliding paths",
          );
        }
        seenPaths.add(candidate.path);
        seenPortable.add(portable);
        entries.push(
          candidate.operation === "delete"
            ? {
                ordinal: entries.length,
                path: candidate.path,
                portablePathKey: portable,
                operation: "delete",
                entryType: null,
                mode: null,
                contentSha256: null,
                sizeBytes: null,
                stageName: null,
                remoteBlobId: null,
              }
            : {
                ordinal: entries.length,
                path: candidate.path,
                portablePathKey: portable,
                operation: "upsert",
                entryType: candidate.entryType,
                mode: candidate.mode,
                contentSha256: candidate.contentSha256,
                sizeBytes: candidate.sizeBytes,
                stageName: candidate.contentSha256,
                remoteBlobId: candidate.blobId,
              },
        );
      }
      if (entries.length > MAX_ENTRIES)
        throw remoteProtocolError(job.jobId, "Cloud export is too large");
      afterPath = page.nextAfterPath;
    } while (afterPath !== null);
    const liveEntries = entries.filter((entry) => entry.operation === "upsert");
    if (
      !manifest ||
      manifest.fileCount !== liveEntries.length ||
      manifest.totalBytes > MAX_TOTAL_BYTES ||
      liveEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0) !==
        manifest.totalBytes
    ) {
      throw remoteProtocolError(
        job.jobId,
        "Cloud export manifest summary is invalid",
      );
    }
    if (
      checkpointBinding?.kind === "projection-v1" &&
      (seenPaths.size !==
        checkpointBinding.entries.size + checkpointBinding.deletions.size ||
        [...checkpointBinding.entries.keys()].some(
          (entryPath) => !seenPaths.has(entryPath),
        ) ||
        [...checkpointBinding.deletions].some(
          (entryPath) => !seenPaths.has(entryPath),
        ))
    ) {
      throw remoteProtocolError(
        job.jobId,
        "Cloud export pages do not match their checkpoint manifest",
      );
    }

    const records: CloudWorkspaceForkRecordEvent[] = [];
    if (manifest.includeChats) {
      let afterRevision = 0;
      let hasMore = true;
      while (hasMore) {
        this.assertJobActive(job.jobId);
        const page: CloudWorkspaceForkRecordPage = await withGrant((token) =>
          context.api.readForkRecords({
            organizationId: job.organizationId,
            workspaceId: job.sourceWorkspaceId,
            forkIntentId: job.remoteForkIntentId!,
            grantToken: token,
            afterRevision,
            limit: 20,
          }),
        );
        this.assertJobActive(job.jobId);
        if (page.recordRevision !== manifest.recordRevision) {
          throw remoteProtocolError(
            job.jobId,
            "Cloud export record head changed",
          );
        }
        if (page.hasMore && page.events.length === 0) {
          throw remoteProtocolError(
            job.jobId,
            "Cloud export record pagination made no progress",
          );
        }
        for (const event of page.events) {
          if (event.revision !== afterRevision + 1) {
            throw remoteProtocolError(
              job.jobId,
              "Cloud export record stream is discontinuous",
            );
          }
          records.push(event);
          afterRevision = event.revision;
        }
        if (records.length > MAX_RECORDS)
          throw remoteProtocolError(
            job.jobId,
            "Cloud export has too many records",
          );
        hasMore = page.hasMore;
      }
      if (afterRevision !== manifest.recordRevision) {
        throw remoteProtocolError(
          job.jobId,
          "Cloud export record stream is incomplete",
        );
      }
    }

    this.state.replacePayload({
      jobId: job.jobId,
      entries,
      records: records as unknown as Record<string, unknown>[],
    });
    const unique = new Map<
      string,
      Extract<CloudWorkspaceForkJobEntry, { operation: "upsert" }>
    >();
    for (const entry of entries) {
      if (entry.operation !== "upsert") continue;
      const prior = unique.get(entry.remoteBlobId!);
      if (
        prior &&
        (prior.contentSha256 !== entry.contentSha256 ||
          prior.sizeBytes !== entry.sizeBytes)
      ) {
        throw remoteProtocolError(
          job.jobId,
          "Cloud export blob descriptor is inconsistent",
        );
      }
      unique.set(entry.remoteBlobId!, entry);
    }
    for (const entry of unique.values()) {
      this.assertJobActive(job.jobId);
      try {
        const staged = await readCloudWorkspaceForkBlob({
          jobId: job.jobId,
          stageName: entry.stageName,
          sha256: entry.contentSha256,
          sizeBytes: entry.sizeBytes,
        });
        this.assertJobActive(job.jobId);
        staged.fill(0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const bytes = await withGrant((token) =>
        context.api.readForkBlob({
          organizationId: job.organizationId,
          workspaceId: job.sourceWorkspaceId,
          forkIntentId: job.remoteForkIntentId!,
          grantToken: token,
          blobId: entry.remoteBlobId!,
          expectedSizeBytes: entry.sizeBytes,
          expectedSha256: entry.contentSha256,
        }),
      );
      this.assertJobActive(job.jobId);
      try {
        await stageCloudWorkspaceForkBlob({
          jobId: job.jobId,
          sha256: entry.contentSha256,
          bytes,
        });
        this.assertJobActive(job.jobId);
      } finally {
        bytes.fill(0);
      }
    }
    return { manifest, entries, records };
  }

  private async validateRepository(
    job: CloudWorkspaceForkJob,
    manifest: ExportManifest,
  ) {
    if (
      !isKnownRepoRoot(job.repoRoot) ||
      !(await isRepo(job.repoRoot)) ||
      (await realpath(job.repoRoot).catch(() => null)) !== job.repoRoot
    ) {
      throw new Error("Local repository is unavailable");
    }
    const remote = parseGitHubRemote(await readOriginUrl(job.repoRoot));
    if (
      remote.owner.toLowerCase() !== manifest.repository.owner.toLowerCase() ||
      remote.repo.toLowerCase() !== manifest.repository.name.toLowerCase()
    ) {
      throw new Error("Local repository does not match the cloud workspace");
    }
  }

  private async resumeCloudToLocal(
    initial: CloudWorkspaceForkJob,
    context: DesktopContext,
  ): Promise<CloudWorkspaceForkJob> {
    let job = initial;
    let request = asCloudRequest(job);
    this.assertJobActive(job.jobId);
    if (!job.remoteForkIntentId) {
      job = this.move(job, "requesting_export");
      const requested = await context.api.requestCloudToLocal({
        organizationId: job.organizationId,
        workspaceId: job.sourceWorkspaceId,
        targetLocalWorkspaceId: job.targetWorkspaceId,
        includeChats: request.includeChats,
        idempotencyKey: `fork.${job.jobId}.export`,
      });
      this.assertJobActive(job.jobId);
      job = this.move(job, "waiting_export", {
        remoteForkIntentId: requested.forkIntentId,
        checkpointRequestId: requested.checkpointRequestId,
      });
    } else {
      job = this.move(job, "waiting_export");
    }
    const downloaded = await this.downloadExport(job, context);
    this.assertJobActive(job.jobId);
    if (!downloaded) return job;
    await (this.dependencies.validateRepository?.(job, downloaded.manifest) ??
      this.validateRepository(job, downloaded.manifest));
    this.assertJobActive(job.jobId);
    job = this.move(job, "downloading", {
      checkpointId: downloaded.manifest.checkpointId,
      manifest: downloaded.manifest as unknown as Record<string, unknown>,
    });

    if (!request.prepared) {
      const prepared = await (
        this.dependencies.prepareWorkspaceCreate ?? prepareWorkspaceCreate
      )({ repoRoot: job.repoRoot });
      this.assertJobActive(job.jobId);
      request = {
        ...request,
        prepared: {
          workspaceId: prepared.workspaceId,
          branch: prepared.branch,
          repoSlug: prepared.repoSlug,
        },
      };
      job = this.state.setLocalTarget({
        jobId: job.jobId,
        targetWorkspaceAlias: prepared.workspaceId,
        request: request as unknown as Record<string, unknown>,
        now: this.now(),
      });
    }
    if (getWorkspaceByCanonicalId(job.targetWorkspaceId)) {
      throw new Error("Cloud copy target identity already exists locally");
    }
    job = this.move(job, "materializing");
    const events = this.state.records(
      job.jobId,
    ) as unknown as CloudWorkspaceForkRecordEvent[];
    const entries = this.state.entries(job.jobId);
    await (this.dependencies.createWorkspace ?? createWorkspace)(
      {
        repoRoot: job.repoRoot,
        repoSlug: request.prepared!.repoSlug,
        preparedId: request.prepared!.workspaceId,
        preparedBranch: request.prepared!.branch,
        runRepoScripts: false,
      },
      {
        canonicalId: job.targetWorkspaceId,
        exactBaseCommit: downloaded.manifest.gitBaseCommit,
        provision: ({ workspacePath }) =>
          materializeCloudWorkspaceFork({
            jobId: job.jobId,
            workspaceRoot: workspacePath,
            entries,
          }),
        beforePublish: ({ workspaceId, canonicalId, workspacePath }) => {
          // Session replacement/shutdown may race materialization. This is the
          // last reversible boundary before the new local workspace identity
          // becomes visible, so never publish a cancelled cloud export.
          this.assertJobActive(job.jobId);
          if (request.includeChats) {
            importCloudWorkspaceForkRecords({
              targetRoot: workspacePath,
              targetWorkspaceId: workspaceId,
              targetWorkspaceCanonicalId: canonicalId,
              events,
            });
          }
          job = this.move(job, "succeeded", {
            checkpointId: downloaded.manifest.checkpointId,
          });
        },
      },
    );
    this.assertJobActive(job.jobId);
    await this.cleanupStage(job.jobId);
    return this.state.job(job.jobId)!;
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    let context: DesktopContext;
    try {
      context = this.dependencies.context();
    } catch {
      return;
    }
    const jobs = this.state
      .resumable(context.accountUserId, this.now())
      .slice(0, 2);
    for (const job of jobs) {
      await this.run(job.jobId).catch((error) =>
        this.dependencies.logger?.warn(
          `[cloud-fork] copy deferred (${runtimeCode(error)})`,
        ),
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.cancelActiveWork();
    this.active.clear();
    this.activeControllers.clear();
  }
}
