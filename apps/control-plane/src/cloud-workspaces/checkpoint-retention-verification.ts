import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { requireOrganizationRole } from "../authz.js";
import { withSystemTx } from "../db.js";
import { cloudRecoveryPointLosslessSql } from "./automatic-recovery.js";

const MAX_BLOBS = 50_000;
const MAX_BYTES = 10 * 1024 ** 3;
const MAX_DURATION_MS = 5 * 60_000;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export type StoppedCheckpointSnapshot = {
  workspaceId: string; organizationId: string; generation: number;
  authorityEpoch: string; version: string; ownerUserId: string; status: string;
  currentContentRevision: string; currentRecordRevision: string;
  checkpointId: string; checkpointGeneration: number; checkpointAt: string;
  manifestBlobId: string; integritySha256: string; finalCheckpoint: boolean;
  blobs: Array<{ id: string; sha256: string; sizeBytes: number }>;
};
type Failure = "checkpoint_scope_unavailable" | "checkpoint_not_stopped" | "checkpoint_unavailable" |
  "checkpoint_integrity_failed" | "checkpoint_verification_changed" | "checkpoint_verification_limit" |
  "checkpoint_verification_timeout" | "checkpoint_object_unavailable";
export class CheckpointVerificationError extends Error {
  constructor(readonly code: Failure) { super("Checkpoint objects could not be verified"); }
}
function fail(code: Failure): never { throw new CheckpointVerificationError(code); }

/** One fixed budget covers metadata, every object and the final fence. A late
 * object reply is wiped even after the caller has received its timeout. */
function bounded<T>(read: () => Promise<T>, deadline: number, now: () => number, wipeLate?: (value: T) => void): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) return Promise.reject(new CheckpointVerificationError("checkpoint_verification_timeout"));
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      finished = true; reject(new CheckpointVerificationError("checkpoint_verification_timeout"));
    }, remaining);
    timer.unref?.();
    void Promise.resolve().then(read).then(value => {
      if (finished) { wipeLate?.(value); return; }
      clearTimeout(timer); finished = true;
      if (now() >= deadline) { wipeLate?.(value); reject(new CheckpointVerificationError("checkpoint_verification_timeout")); }
      else resolve(value);
    }, error => { if (!finished) { clearTimeout(timer); finished = true; reject(error); } });
  });
}

/** No VM provider calls, writes or implicit wake. This proves R2/file-store bytes,
 * not that a periodic capture contains everything left on a stopped disk. */
export async function verifyStoppedWorkspaceCheckpoint(ports: {
  readSnapshot(): Promise<StoppedCheckpointSnapshot>;
  readBlob(blobId: string): Promise<Buffer>;
}, options: { verify: boolean; maxBlobs?: number; maxBytes?: number; timeoutMs?: number; now?: () => number }) {
  const now = options.now ?? Date.now;
  const limit = (value: number | undefined, maximum: number) => {
    if (value === undefined) return maximum;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail("checkpoint_verification_limit");
    return value;
  };
  const deadline = now() + limit(options.timeoutMs, MAX_DURATION_MS);
  const maxBlobs = limit(options.maxBlobs, MAX_BLOBS), maxBytes = limit(options.maxBytes, MAX_BYTES);
  const before = await bounded(ports.readSnapshot, deadline, now);
  if (before.blobs.find(blob => blob.id === before.manifestBlobId)?.sha256 !== before.integritySha256)
    fail("checkpoint_integrity_failed");
  const bytes = before.blobs.reduce((total, blob) => total + blob.sizeBytes, 0);
  if (before.blobs.length > maxBlobs || !Number.isSafeInteger(bytes) || bytes > maxBytes ||
      before.blobs.some(blob => !Number.isSafeInteger(blob.sizeBytes) || blob.sizeBytes < 0)) fail("checkpoint_verification_limit");
  const result = { schema: "zeros.stopped-checkpoint-verification/v1" as const,
    organizationId: before.organizationId, workspaceId: before.workspaceId, generation: before.generation,
    authorityEpoch: before.authorityEpoch, workspaceVersion: before.version, checkpointId: before.checkpointId,
    currentContentRevision: before.currentContentRevision, currentRecordRevision: before.currentRecordRevision,
    checkpointGeneration: before.checkpointGeneration, checkpointAt: before.checkpointAt,
    integritySha256: before.integritySha256, blobCount: before.blobs.length, totalBlobBytes: bytes,
    coverage: before.finalCheckpoint ? "final_checkpoint" as const : "checkpoint_only" as const };
  if (!options.verify) return { ...result, state: "planned" as const, verifiedAt: null };
  for (const blob of before.blobs) {
    let body: Buffer;
    try { body = await bounded(() => ports.readBlob(blob.id), deadline, now, late => { late.fill(0); }); }
    catch (error) {
      if (error instanceof CheckpointVerificationError) throw error;
      return fail("checkpoint_object_unavailable");
    }
    try {
      if (body.length !== blob.sizeBytes || sha(body) !== blob.sha256) fail("checkpoint_integrity_failed");
    } finally { body.fill(0); }
  }
  const after = await bounded(ports.readSnapshot, deadline, now);
  if (sha(JSON.stringify(before)) !== sha(JSON.stringify(after))) fail("checkpoint_verification_changed");
  return { ...result, state: "verified" as const, verifiedAt: new Date(now()).toISOString() };
}

/** Repeatable-read metadata only. No exclusive owner/workspace lock is held
 * while decrypting or hashing objects. The same authorization runs on reread. */
export async function loadStoppedCheckpointSnapshot(pool: pg.Pool, input: {
  workspaceId: string; organizationId: string; actorUserId: string; expectedOrganizationSlug: string;
}): Promise<StoppedCheckpointSnapshot> {
  if ([input.workspaceId, input.organizationId, input.actorUserId].some(id => !z.string().uuid().safeParse(id).success))
    fail("checkpoint_scope_unavailable");
  return withSystemTx(pool, async tx => {
    const organization = (await tx.query<{ slug: string }>(`SELECT org.slug FROM organizations org
      JOIN users actor ON actor.id=$2 AND actor.auth_status='active' AND actor.deleted_at IS NULL
      WHERE org.id=$1 AND NOT org.is_personal AND org.lifecycle_status='active' AND org.deleted_at IS NULL`,
    [input.organizationId, input.actorUserId])).rows[0];
    if (!organization || organization.slug.toLowerCase() !== input.expectedOrganizationSlug.toLowerCase()) fail("checkpoint_scope_unavailable");
    try { await requireOrganizationRole(tx, input.organizationId, input.actorUserId, "admin"); }
    catch { return fail("checkpoint_scope_unavailable"); }
    const row = (await tx.query<{
      current_generation: number; authority_epoch: string; version: string; owner_user_id: string; status: string;
      current_content_revision: string; current_record_revision: string;
      checkpoint_id: string | null; checkpoint_generation: number | null; durable_at: Date | null;
      manifest_blob_id: string | null; integrity_sha256: Buffer | null; final_checkpoint: boolean;
    }>(`SELECT workspace.current_generation,workspace.authority_epoch,workspace.version,workspace.owner_user_id,workspace.status,
      head.current_revision AS current_content_revision,coalesce(record_head.current_revision,0) AS current_record_revision,
      checkpoint.id AS checkpoint_id,checkpoint.generation AS checkpoint_generation,checkpoint.durable_at,
      checkpoint.manifest_blob_id,checkpoint.integrity_sha256,
      coalesce(${cloudRecoveryPointLosslessSql("workspace.current_generation")},false) AS final_checkpoint
      FROM cloud_workspaces workspace
      JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=workspace.id AND binding.org_id=workspace.org_id
        AND binding.generation=workspace.current_generation AND binding.provider='boat' AND binding.observed_state='stopped'
      LEFT JOIN workspace_content_heads head ON head.workspace_id=workspace.id AND head.org_id=workspace.org_id
      LEFT JOIN workspace_record_heads record_head ON record_head.workspace_id=workspace.id AND record_head.org_id=workspace.org_id
      LEFT JOIN workspace_checkpoints checkpoint ON checkpoint.id=head.current_checkpoint_id
        AND checkpoint.workspace_id=workspace.id AND checkpoint.org_id=workspace.org_id AND checkpoint.state='durable'
      WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.status IN ('stopped','archived','failed')
        AND workspace.desired_state='stopped' AND workspace.deleted_at IS NULL AND workspace.data_deleted_at IS NULL`,
    [input.workspaceId, input.organizationId])).rows[0];
    if (!row) fail("checkpoint_not_stopped");
    if (!row.checkpoint_id || !row.checkpoint_generation || !row.durable_at || !row.manifest_blob_id || !row.integrity_sha256)
      fail("checkpoint_unavailable");
    const objects = (await tx.query<{ id: string; state: string | null; plaintext_sha256: Buffer | null; plaintext_bytes: string | null }>(`
      SELECT needed.id,blob.state,blob.plaintext_sha256,blob.plaintext_bytes FROM workspace_checkpoints checkpoint
      CROSS JOIN LATERAL (
        SELECT checkpoint.manifest_blob_id AS id UNION SELECT checkpoint.artifact_blob_id
        UNION SELECT entry.blob_id FROM workspace_checkpoint_entries entry WHERE entry.checkpoint_id=checkpoint.id
        UNION SELECT reference.blob_id FROM workspace_blob_references reference
          WHERE reference.workspace_id=checkpoint.workspace_id AND reference.org_id=checkpoint.org_id
            AND reference.reference_id IN (checkpoint.id::text,checkpoint.id::text||':v2')
      ) needed LEFT JOIN workspace_blobs blob ON blob.id=needed.id AND blob.org_id=checkpoint.org_id
      WHERE checkpoint.id=$1 AND checkpoint.workspace_id=$2 AND checkpoint.org_id=$3 AND needed.id IS NOT NULL
      ORDER BY needed.id LIMIT $4`, [row.checkpoint_id, input.workspaceId, input.organizationId, MAX_BLOBS + 1])).rows;
    if (objects.some(blob => blob.state !== "available" || !blob.plaintext_sha256 || blob.plaintext_bytes === null))
      fail("checkpoint_object_unavailable");
    return { workspaceId: input.workspaceId, organizationId: input.organizationId,
      generation: row.current_generation, authorityEpoch: String(row.authority_epoch), version: String(row.version),
      currentContentRevision: String(row.current_content_revision), currentRecordRevision: String(row.current_record_revision),
      ownerUserId: row.owner_user_id, status: row.status, checkpointId: row.checkpoint_id,
      checkpointGeneration: row.checkpoint_generation, checkpointAt: row.durable_at.toISOString(),
      manifestBlobId: row.manifest_blob_id, integritySha256: row.integrity_sha256.toString("hex"),
      finalCheckpoint: row.final_checkpoint,
      blobs: objects.map(blob => ({ id: blob.id, sha256: blob.plaintext_sha256!.toString("hex"), sizeBytes: Number(blob.plaintext_bytes) })) };
  }, { consistentRead: true });
}
