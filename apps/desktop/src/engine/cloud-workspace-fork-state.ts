import type Database from "better-sqlite3";

export type CloudWorkspaceForkJobOperation =
  | "local_to_cloud"
  | "cloud_to_local";

export type CloudWorkspaceForkJobState =
  | "prepared"
  | "snapshotting"
  | "creating_remote"
  | "uploading"
  | "finalizing"
  | "requesting_export"
  | "waiting_export"
  | "downloading"
  | "materializing"
  | "succeeded"
  | "failed"
  | "cancelled";

export type CloudWorkspaceForkJob = {
  jobId: string;
  operation: CloudWorkspaceForkJobOperation;
  accountUserId: string;
  organizationId: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  sourceWorkspaceAlias: string | null;
  targetWorkspaceAlias: string | null;
  repoRoot: string;
  request: Record<string, unknown>;
  state: CloudWorkspaceForkJobState;
  remoteForkIntentId: string | null;
  remoteLifecycleIntentId: string | null;
  checkpointRequestId: string | null;
  checkpointId: string | null;
  sourceSnapshotSha256: string | null;
  sourceRevision: number | null;
  manifest: Record<string, unknown> | null;
  attemptCount: number;
  nextAttemptAt: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type CloudWorkspaceForkJobEntry =
  | {
      ordinal: number;
      path: string;
      portablePathKey: string;
      operation: "delete";
      entryType: null;
      mode: null;
      contentSha256: null;
      sizeBytes: null;
      stageName: null;
      remoteBlobId: null;
    }
  | {
      ordinal: number;
      path: string;
      portablePathKey: string;
      operation: "upsert";
      entryType: "file" | "symlink";
      mode: 33188 | 33261 | 40960;
      contentSha256: string;
      sizeBytes: number;
      stageName: string;
      remoteBlobId: string | null;
    };

type JobRow = {
  job_id: string;
  operation: CloudWorkspaceForkJobOperation;
  account_user_id: string;
  organization_id: string;
  source_workspace_id: string;
  target_workspace_id: string;
  source_workspace_alias: string | null;
  target_workspace_alias: string | null;
  repo_root: string;
  request_json: string;
  state: CloudWorkspaceForkJobState;
  remote_fork_intent_id: string | null;
  remote_lifecycle_intent_id: string | null;
  checkpoint_request_id: string | null;
  checkpoint_id: string | null;
  source_snapshot_sha256: string | null;
  source_revision: number | null;
  manifest_json: string | null;
  attempt_count: number;
  next_attempt_at: number;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type EntryRow = {
  ordinal: number;
  normalized_path: string;
  portable_path_key: string;
  operation: "upsert" | "delete";
  entry_type: "file" | "symlink" | null;
  mode: number | null;
  content_sha256: string | null;
  size_bytes: number | null;
  stage_name: string | null;
  remote_blob_id: string | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function parseObject(raw: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Mapped below so corrupted local state never reaches protocol code.
  }
  throw new Error(`${label} is corrupt`);
}

function toJob(row: JobRow): CloudWorkspaceForkJob {
  return {
    jobId: row.job_id,
    operation: row.operation,
    accountUserId: row.account_user_id,
    organizationId: row.organization_id,
    sourceWorkspaceId: row.source_workspace_id,
    targetWorkspaceId: row.target_workspace_id,
    sourceWorkspaceAlias: row.source_workspace_alias,
    targetWorkspaceAlias: row.target_workspace_alias,
    repoRoot: row.repo_root,
    request: parseObject(row.request_json, "Cloud copy request"),
    state: row.state,
    remoteForkIntentId: row.remote_fork_intent_id,
    remoteLifecycleIntentId: row.remote_lifecycle_intent_id,
    checkpointRequestId: row.checkpoint_request_id,
    checkpointId: row.checkpoint_id,
    sourceSnapshotSha256: row.source_snapshot_sha256,
    sourceRevision: row.source_revision,
    manifest:
      row.manifest_json === null
        ? null
        : parseObject(row.manifest_json, "Cloud copy manifest"),
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function toEntry(row: EntryRow): CloudWorkspaceForkJobEntry {
  if (row.operation === "delete") {
    return {
      ordinal: row.ordinal,
      path: row.normalized_path,
      portablePathKey: row.portable_path_key,
      operation: "delete",
      entryType: null,
      mode: null,
      contentSha256: null,
      sizeBytes: null,
      stageName: null,
      remoteBlobId: null,
    };
  }
  if (
    !["file", "symlink"].includes(row.entry_type ?? "") ||
    ![33188, 33261, 40960].includes(row.mode ?? 0) ||
    !SHA256_PATTERN.test(row.content_sha256 ?? "") ||
    !Number.isSafeInteger(row.size_bytes) ||
    row.size_bytes! < 0 ||
    !SHA256_PATTERN.test(row.stage_name ?? "")
  ) {
    throw new Error("Cloud copy entry is corrupt");
  }
  return {
    ordinal: row.ordinal,
    path: row.normalized_path,
    portablePathKey: row.portable_path_key,
    operation: "upsert",
    entryType: row.entry_type as "file" | "symlink",
    mode: row.mode as 33188 | 33261 | 40960,
    contentSha256: row.content_sha256!,
    sizeBytes: row.size_bytes!,
    stageName: row.stage_name!,
    remoteBlobId: row.remote_blob_id,
  };
}

function safeJson(value: Record<string, unknown>, label: string): string {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > 1024 * 1024) {
    throw new Error(`${label} is invalid`);
  }
  return encoded;
}

export class DatabaseCloudWorkspaceForkState {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    jobId: string;
    operation: CloudWorkspaceForkJobOperation;
    accountUserId: string;
    organizationId: string;
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    sourceWorkspaceAlias?: string | null;
    targetWorkspaceAlias?: string | null;
    repoRoot: string;
    request: Record<string, unknown>;
    now: number;
  }): CloudWorkspaceForkJob {
    for (const value of [
      input.jobId,
      input.accountUserId,
      input.organizationId,
      input.sourceWorkspaceId,
      input.targetWorkspaceId,
    ]) {
      if (!UUID_PATTERN.test(value)) throw new Error("Cloud copy identity is invalid");
    }
    if (
      input.sourceWorkspaceId === input.targetWorkspaceId ||
      !Number.isSafeInteger(input.now) ||
      input.now < 0
    ) {
      throw new Error("Cloud copy identity is invalid");
    }
    this.db
      .prepare(
        `INSERT INTO cloud_workspace_fork_jobs (
           job_id, operation, account_user_id, organization_id,
           source_workspace_id, target_workspace_id, source_workspace_alias,
           target_workspace_alias, repo_root, request_json, state,
           next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)`,
      )
      .run(
        input.jobId,
        input.operation,
        input.accountUserId,
        input.organizationId,
        input.sourceWorkspaceId,
        input.targetWorkspaceId,
        input.sourceWorkspaceAlias ?? null,
        input.targetWorkspaceAlias ?? null,
        input.repoRoot,
        safeJson(input.request, "Cloud copy request"),
        input.now,
        input.now,
        input.now,
      );
    return this.job(input.jobId)!;
  }

  job(jobId: string): CloudWorkspaceForkJob | null {
    const row = this.db
      .prepare<[string], JobRow>(
        `SELECT * FROM cloud_workspace_fork_jobs WHERE job_id = ?`,
      )
      .get(jobId);
    return row ? toJob(row) : null;
  }

  jobs(accountUserId: string): CloudWorkspaceForkJob[] {
    return this.db
      .prepare<[string], JobRow>(
        `SELECT * FROM cloud_workspace_fork_jobs
         WHERE account_user_id = ? ORDER BY created_at DESC, job_id DESC`,
      )
      .all(accountUserId)
      .map(toJob);
  }

  resumable(accountUserId: string, now: number): CloudWorkspaceForkJob[] {
    return this.db
      .prepare<[string, number], JobRow>(
        `SELECT * FROM cloud_workspace_fork_jobs
         WHERE account_user_id = ?
           AND state NOT IN ('succeeded', 'cancelled')
           AND next_attempt_at <= ?
         ORDER BY updated_at, job_id`,
      )
      .all(accountUserId, now)
      .map(toJob);
  }

  transition(input: {
    jobId: string;
    from: readonly CloudWorkspaceForkJobState[];
    to: CloudWorkspaceForkJobState;
    now: number;
    remoteForkIntentId?: string | null;
    remoteLifecycleIntentId?: string | null;
    checkpointRequestId?: string | null;
    checkpointId?: string | null;
    sourceSnapshotSha256?: string | null;
    sourceRevision?: number | null;
    manifest?: Record<string, unknown> | null;
  }): CloudWorkspaceForkJob {
    if (input.from.length < 1) throw new Error("Cloud copy transition is invalid");
    const placeholders = input.from.map(() => "?").join(", ");
    const current = this.job(input.jobId);
    if (!current || !input.from.includes(current.state)) {
      throw new Error("Cloud copy state changed concurrently");
    }
    const result = this.db
      .prepare(
        `UPDATE cloud_workspace_fork_jobs
         SET state = ?, updated_at = ?, next_attempt_at = ?,
             attempt_count = attempt_count + 1,
             remote_fork_intent_id = ?, remote_lifecycle_intent_id = ?,
             checkpoint_request_id = ?, checkpoint_id = ?,
             source_snapshot_sha256 = ?, source_revision = ?,
             manifest_json = ?, last_error_code = NULL,
             last_error_message = NULL,
             completed_at = CASE WHEN ? IN ('succeeded', 'cancelled')
                                 THEN ? ELSE NULL END
         WHERE job_id = ? AND state IN (${placeholders})`,
      )
      .run(
        input.to,
        input.now,
        input.now,
        input.remoteForkIntentId === undefined
          ? current.remoteForkIntentId
          : input.remoteForkIntentId,
        input.remoteLifecycleIntentId === undefined
          ? current.remoteLifecycleIntentId
          : input.remoteLifecycleIntentId,
        input.checkpointRequestId === undefined
          ? current.checkpointRequestId
          : input.checkpointRequestId,
        input.checkpointId === undefined ? current.checkpointId : input.checkpointId,
        input.sourceSnapshotSha256 === undefined
          ? current.sourceSnapshotSha256
          : input.sourceSnapshotSha256,
        input.sourceRevision === undefined
          ? current.sourceRevision
          : input.sourceRevision,
        input.manifest === undefined
          ? current.manifest === null
            ? null
            : safeJson(current.manifest, "Cloud copy manifest")
          : input.manifest === null
            ? null
            : safeJson(input.manifest, "Cloud copy manifest"),
        input.to,
        input.now,
        input.jobId,
        ...input.from,
      );
    if (result.changes !== 1) throw new Error("Cloud copy state changed concurrently");
    return this.job(input.jobId)!;
  }

  fail(input: {
    jobId: string;
    code: string;
    message: string;
    now: number;
    retryAt: number;
  }): CloudWorkspaceForkJob {
    const code = input.code.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 96) || "failed";
    // eslint-disable-next-line no-control-regex -- persisted error text strips C0 and DEL
    const message = input.message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512);
    const result = this.db
      .prepare(
        `UPDATE cloud_workspace_fork_jobs
         SET state = 'failed', updated_at = ?, next_attempt_at = ?,
             last_error_code = ?, last_error_message = ?, completed_at = NULL
         WHERE job_id = ? AND state NOT IN ('succeeded', 'cancelled')`,
      )
      .run(input.now, input.retryAt, code, message, input.jobId);
    if (result.changes !== 1) throw new Error("Cloud copy state changed concurrently");
    return this.job(input.jobId)!;
  }

  setLocalTarget(input: {
    jobId: string;
    targetWorkspaceAlias: string;
    request: Record<string, unknown>;
    now: number;
  }): CloudWorkspaceForkJob {
    if (
      !/^ws_[a-z0-9]{6}-[a-z0-9-]+$/.test(input.targetWorkspaceAlias) ||
      !Number.isSafeInteger(input.now) ||
      input.now < 0
    ) {
      throw new Error("Cloud copy local target is invalid");
    }
    const result = this.db
      .prepare(
        `UPDATE cloud_workspace_fork_jobs
         SET target_workspace_alias = ?, request_json = ?, updated_at = ?
         WHERE job_id = ? AND operation = 'cloud_to_local'
           AND state NOT IN ('succeeded', 'cancelled')
           AND (target_workspace_alias IS NULL OR target_workspace_alias = ?)`,
      )
      .run(
        input.targetWorkspaceAlias,
        safeJson(input.request, "Cloud copy request"),
        input.now,
        input.jobId,
        input.targetWorkspaceAlias,
      );
    if (result.changes !== 1) throw new Error("Cloud copy local target changed");
    return this.job(input.jobId)!;
  }

  replacePayload(input: {
    jobId: string;
    entries: readonly CloudWorkspaceForkJobEntry[];
    records: readonly Record<string, unknown>[];
  }): void {
    const insertEntry = this.db.prepare(
      `INSERT INTO cloud_workspace_fork_job_entries (
         job_id, ordinal, normalized_path, portable_path_key, operation,
         entry_type, mode, content_sha256, size_bytes, stage_name, remote_blob_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertRecord = this.db.prepare(
      `INSERT INTO cloud_workspace_fork_job_records (job_id, ordinal, record_json)
       VALUES (?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM cloud_workspace_fork_job_entries WHERE job_id = ?`).run(
        input.jobId,
      );
      this.db.prepare(`DELETE FROM cloud_workspace_fork_job_records WHERE job_id = ?`).run(
        input.jobId,
      );
      input.entries.forEach((entry, index) => {
        if (entry.ordinal !== index) throw new Error("Cloud copy entry order is invalid");
        insertEntry.run(
          input.jobId,
          entry.ordinal,
          entry.path,
          entry.portablePathKey,
          entry.operation,
          entry.entryType,
          entry.mode,
          entry.contentSha256,
          entry.sizeBytes,
          entry.stageName,
          entry.remoteBlobId,
        );
      });
      input.records.forEach((record, index) => {
        insertRecord.run(
          input.jobId,
          index,
          safeJson(record, "Cloud copy record"),
        );
      });
    })();
  }

  entries(jobId: string): CloudWorkspaceForkJobEntry[] {
    return this.db
      .prepare<[string], EntryRow>(
        `SELECT ordinal, normalized_path, portable_path_key, operation,
                entry_type, mode, content_sha256, size_bytes, stage_name,
                remote_blob_id
         FROM cloud_workspace_fork_job_entries
         WHERE job_id = ? ORDER BY ordinal`,
      )
      .all(jobId)
      .map(toEntry);
  }

  records(jobId: string): Record<string, unknown>[] {
    return this.db
      .prepare<[string], { record_json: string }>(
        `SELECT record_json FROM cloud_workspace_fork_job_records
         WHERE job_id = ? ORDER BY ordinal`,
      )
      .all(jobId)
      .map((row) => parseObject(row.record_json, "Cloud copy record"));
  }

  setRemoteBlob(jobId: string, ordinal: number, blobId: string): void {
    if (!UUID_PATTERN.test(blobId)) throw new Error("Cloud copy blob identity is invalid");
    const result = this.db
      .prepare(
        `UPDATE cloud_workspace_fork_job_entries SET remote_blob_id = ?
         WHERE job_id = ? AND ordinal = ? AND operation = 'upsert'
           AND (remote_blob_id IS NULL OR remote_blob_id = ?)`,
      )
      .run(blobId, jobId, ordinal, blobId);
    if (result.changes !== 1) throw new Error("Cloud copy blob state changed");
  }

  remove(jobId: string): void {
    this.db.prepare(`DELETE FROM cloud_workspace_fork_jobs WHERE job_id = ?`).run(jobId);
  }
}
