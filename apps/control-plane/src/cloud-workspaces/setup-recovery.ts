import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type pg from "pg";

import { withSystemTx, type Tx } from "../db.js";
import type { DatabaseCloudWorkspaceBlobService } from "./object-store.js";

const RECOVERY_TOKEN_PATTERN = /^zrc_[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 500;

export class CloudWorkspaceSetupRecoveryError extends Error {
  constructor(
    public readonly code: "recovery_capability_rejected" | "recovery_blob_unavailable",
  ) {
    super("Cloud workspace recovery request was not accepted");
    this.name = "CloudWorkspaceSetupRecoveryError";
  }
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function sameHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export type WorkspaceSetupRecoveryMaterial = {
  version: 1;
  audience: "zeros-cloud-workspace-recovery-v1";
  checkpointId: string;
  contentRevision: number;
  recordRevision: number;
  endpoint: string;
  token: string;
  expiresAtMs: number;
};

/** Select and bind one immutable checkpoint to one setup run. A wake may use
 * the current durable checkpoint; a replacement/import generation can pin an
 * older source checkpoint explicitly on its generation row. */
export async function issueWorkspaceSetupRecoveryGrant(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    setupRunId: string;
    executionFence: number;
    endpoint: string;
    ttlSeconds: number;
  },
): Promise<WorkspaceSetupRecoveryMaterial | null> {
  if (
    !UUID_PATTERN.test(input.workspaceId) ||
    !UUID_PATTERN.test(input.organizationId) ||
    !UUID_PATTERN.test(input.setupRunId) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !Number.isSafeInteger(input.executionFence) ||
    input.executionFence < 1 ||
    !Number.isSafeInteger(input.ttlSeconds) ||
    input.ttlSeconds < 60 ||
    input.ttlSeconds > 7_200
  ) {
    throw new Error("workspace setup recovery grant input is invalid");
  }
  const selected = await tx.query<{
    checkpoint_id: string;
    manifest_blob_id: string;
    artifact_blob_id: string | null;
    content_revision: string | number;
    record_revision: string | number;
  }>(
    `SELECT checkpoint.id AS checkpoint_id, checkpoint.manifest_blob_id,
            checkpoint.artifact_blob_id, checkpoint.content_revision,
            checkpoint.record_revision
     FROM cloud_workspace_generations generation
     LEFT JOIN workspace_content_heads head
       ON head.workspace_id = generation.workspace_id
      AND head.org_id = generation.org_id
     JOIN workspace_checkpoints checkpoint
       ON checkpoint.id = coalesce(
         generation.recovery_checkpoint_id,
         head.current_checkpoint_id
       )
      AND checkpoint.workspace_id = generation.workspace_id
      AND checkpoint.org_id = generation.org_id
      AND checkpoint.state = 'durable'
     WHERE generation.workspace_id = $1 AND generation.generation = $2
       AND generation.org_id = $3
     FOR SHARE OF checkpoint`,
    [input.workspaceId, input.generation, input.organizationId],
  );
  const checkpoint = selected.rows[0];
  if (!checkpoint) return null;

  await tx.query(
    `UPDATE cloud_workspace_generations
     SET recovery_checkpoint_id = coalesce(recovery_checkpoint_id, $4)
     WHERE workspace_id = $1 AND generation = $2 AND org_id = $3`,
    [
      input.workspaceId,
      input.generation,
      input.organizationId,
      checkpoint.checkpoint_id,
    ],
  );
  await tx.query(
    `UPDATE workspace_setup_recovery_grants
     SET revoked_at = coalesce(revoked_at, now())
     WHERE setup_run_id = $1 AND workspace_id = $2 AND generation = $3
       AND org_id = $4 AND revoked_at IS NULL`,
    [
      input.setupRunId,
      input.workspaceId,
      input.generation,
      input.organizationId,
    ],
  );
  const token = `zrc_${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  const grant = await tx.query<{ expires_at: Date }>(
    `INSERT INTO workspace_setup_recovery_grants (
       id, workspace_id, generation, org_id, setup_run_id,
       setup_execution_fence, checkpoint_id, manifest_blob_id,
       artifact_blob_id, token_sha256, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       now() + ($11::bigint * interval '1 second')
     )
     RETURNING expires_at`,
    [
      id,
      input.workspaceId,
      input.generation,
      input.organizationId,
      input.setupRunId,
      input.executionFence,
      checkpoint.checkpoint_id,
      checkpoint.manifest_blob_id,
      checkpoint.artifact_blob_id,
      tokenHash(token),
      input.ttlSeconds,
    ],
  );
  return {
    version: 1,
    audience: "zeros-cloud-workspace-recovery-v1",
    checkpointId: checkpoint.checkpoint_id,
    contentRevision: Number(checkpoint.content_revision),
    recordRevision: Number(checkpoint.record_revision),
    endpoint: input.endpoint,
    token,
    expiresAtMs: grant.rows[0]!.expires_at.getTime(),
  };
}

type RecoveryGrant = {
  checkpointId: string;
  workspaceId: string;
  organizationId: string;
};

async function consumeRecoveryGrantUse(
  tx: Tx,
  token: string,
): Promise<RecoveryGrant> {
  if (!RECOVERY_TOKEN_PATTERN.test(token)) {
    throw new CloudWorkspaceSetupRecoveryError("recovery_capability_rejected");
  }
  const hash = tokenHash(token);
  const grant = await tx.query<{
    token_sha256: Buffer;
    checkpoint_id: string;
    workspace_id: string;
    org_id: string;
  }>(
    `UPDATE workspace_setup_recovery_grants recovery
     SET last_used_at = now(), use_count = use_count + 1
     FROM cloud_workspace_setup_runs setup, cloud_workspaces workspace
     WHERE recovery.token_sha256 = $1
       AND recovery.revoked_at IS NULL AND recovery.expires_at > now()
       AND recovery.use_count < 1000000
       AND setup.id = recovery.setup_run_id
       AND setup.workspace_id = recovery.workspace_id
       AND setup.generation = recovery.generation
       AND setup.org_id = recovery.org_id
       AND setup.execution_fence = recovery.setup_execution_fence
       AND setup.state = 'running' AND setup.lease_expires_at > now()
       AND workspace.id = recovery.workspace_id
       AND workspace.org_id = recovery.org_id
       AND workspace.current_generation = recovery.generation
       AND workspace.desired_state = 'running'
       AND workspace.status = 'setting_up'
       AND workspace.deleted_at IS NULL
     RETURNING recovery.token_sha256, recovery.checkpoint_id,
               recovery.workspace_id, recovery.org_id`,
    [hash],
  );
  const row = grant.rows[0];
  if (!row || !sameHash(row.token_sha256, hash)) {
    throw new CloudWorkspaceSetupRecoveryError("recovery_capability_rejected");
  }
  return {
    checkpointId: row.checkpoint_id,
    workspaceId: row.workspace_id,
    organizationId: row.org_id,
  };
}

export class DatabaseCloudWorkspaceSetupRecoveryService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly blobs: DatabaseCloudWorkspaceBlobService,
  ) {}

  async manifestPage(input: {
    token: string;
    afterPath: string | null;
    limit?: number;
  }): Promise<{
    version: 1;
    audience: "zeros-cloud-workspace-recovery-manifest-v1";
    checkpointId: string;
    contentRevision: number;
    gitBaseCommit: string | null;
    gitHeadRef: string | null;
    fileCount: number;
    totalBytes: number;
    entries: Array<{
      path: string;
      operation: "delete";
    } | {
      path: string;
      operation: "upsert";
      entryType: "file" | "symlink";
      mode: 33188 | 33261 | 40960;
      blobId: string;
      contentSha256: string;
      sizeBytes: number;
    }>;
    nextAfterPath: string | null;
  }> {
    const limit = input.limit ?? MAX_PAGE_SIZE;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_SIZE ||
      (input.afterPath !== null &&
        (input.afterPath.length < 1 ||
          Buffer.byteLength(input.afterPath, "utf8") > 4_096 ||
          input.afterPath !== input.afterPath.normalize("NFC")))
    ) {
      throw new CloudWorkspaceSetupRecoveryError("recovery_capability_rejected");
    }
    return withSystemTx(this.pool, async (tx) => {
      const grant = await consumeRecoveryGrantUse(tx, input.token);
      const checkpoint = await tx.query<{
        content_revision: string | number;
        git_base_commit: string | null;
        git_head_ref: string | null;
        file_count: number;
        total_bytes: string | number;
      }>(
        `SELECT content_revision, git_base_commit, git_head_ref,
                file_count, total_bytes
         FROM workspace_checkpoints
         WHERE id = $1 AND workspace_id = $2 AND org_id = $3
           AND state = 'durable'`,
        [grant.checkpointId, grant.workspaceId, grant.organizationId],
      );
      const metadata = checkpoint.rows[0];
      if (!metadata) {
        throw new CloudWorkspaceSetupRecoveryError("recovery_capability_rejected");
      }
      const entries = await tx.query<{
        normalized_path: string;
        operation: "upsert" | "delete";
        entry_type: "file" | "symlink" | null;
        mode: 33188 | 33261 | 40960 | null;
        blob_id: string | null;
        content_sha256: Buffer | null;
        size_bytes: string | number | null;
      }>(
        `SELECT normalized_path, operation, entry_type, mode, blob_id,
                content_sha256, size_bytes
         FROM workspace_checkpoint_entries
         WHERE checkpoint_id = $1
           AND ($2::text IS NULL OR
                normalized_path COLLATE "C" > ($2::text COLLATE "C"))
         ORDER BY normalized_path COLLATE "C"
         LIMIT $3`,
        [grant.checkpointId, input.afterPath, limit + 1],
      );
      const hasMore = entries.rows.length > limit;
      const page = entries.rows.slice(0, limit);
      return {
        version: 1,
        audience: "zeros-cloud-workspace-recovery-manifest-v1",
        checkpointId: grant.checkpointId,
        contentRevision: Number(metadata.content_revision),
        gitBaseCommit: metadata.git_base_commit,
        gitHeadRef: metadata.git_head_ref,
        fileCount: metadata.file_count,
        totalBytes: Number(metadata.total_bytes),
        entries: page.map((entry) =>
          entry.operation === "delete"
            ? { path: entry.normalized_path, operation: "delete" as const }
            : {
                path: entry.normalized_path,
                operation: "upsert" as const,
                entryType: entry.entry_type!,
                mode: entry.mode!,
                blobId: entry.blob_id!,
                contentSha256: entry.content_sha256!.toString("hex"),
                sizeBytes: Number(entry.size_bytes),
              },
        ),
        nextAfterPath: hasMore ? page.at(-1)!.normalized_path : null,
      };
    });
  }

  async blob(input: { token: string; blobId: string }): Promise<Buffer> {
    if (!UUID_PATTERN.test(input.blobId)) {
      throw new CloudWorkspaceSetupRecoveryError("recovery_capability_rejected");
    }
    const scope = await withSystemTx(this.pool, async (tx) => {
      const grant = await consumeRecoveryGrantUse(tx, input.token);
      const allowed = await tx.query<{ plaintext_sha256: Buffer }>(
        `SELECT blob.plaintext_sha256
         FROM workspace_blobs blob
         WHERE blob.id = $1 AND blob.org_id = $2 AND blob.state = 'available'
           AND (
             EXISTS (
               SELECT 1 FROM workspace_checkpoint_entries entry
               WHERE entry.checkpoint_id = $3 AND entry.blob_id = blob.id
             )
             OR EXISTS (
               SELECT 1 FROM workspace_checkpoints checkpoint
               WHERE checkpoint.id = $3 AND checkpoint.workspace_id = $4
                 AND checkpoint.org_id = $2
                 AND (checkpoint.manifest_blob_id = blob.id
                      OR checkpoint.artifact_blob_id = blob.id)
             )
           )`,
        [
          input.blobId,
          grant.organizationId,
          grant.checkpointId,
          grant.workspaceId,
        ],
      );
      const hash = allowed.rows[0]?.plaintext_sha256;
      if (!hash) {
        throw new CloudWorkspaceSetupRecoveryError("recovery_capability_rejected");
      }
      return { organizationId: grant.organizationId, hash };
    });
    let bytes: Buffer;
    try {
      bytes = await this.blobs.getSystem({
        blobId: input.blobId,
        organizationId: scope.organizationId,
      });
    } catch {
      throw new CloudWorkspaceSetupRecoveryError("recovery_blob_unavailable");
    }
    if (!sameHash(createHash("sha256").update(bytes).digest(), scope.hash)) {
      bytes.fill(0);
      throw new CloudWorkspaceSetupRecoveryError("recovery_blob_unavailable");
    }
    return bytes;
  }
}
