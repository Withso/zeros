import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";

import type pg from "pg";

import { audit } from "../audit.js";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { authorizeCloudWorkspaceOperation } from "./authorization.js";
import {
  assertCloudEngineIdentityForIdempotentReplay,
  assertCurrentCloudEngineAuthority,
} from "./engine-authority.js";
import { completeWorkspaceCheckpointRequest } from "./checkpoint-requests.js";

const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_WORKSPACE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_WORKSPACE_SYMLINK_BYTES = 4_096;
export const MAX_WORKSPACE_FILE_MUTATIONS = 10_000;

export type WorkspaceFileMutation =
  | {
      operation: "upsert";
      path: string;
      entryType: "file" | "symlink";
      mode: 33188 | 33261 | 40960;
      blobId: string;
      contentSha256: string;
      sizeBytes: number;
    }
  | { operation: "delete"; path: string };

export class WorkspaceContentError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "engine_authority_rejected"
      | "revision_conflict"
      | "idempotency_conflict"
      | "blob_unavailable"
      | "checkpoint_not_durable"
      | "checkpoint_request_rejected",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceContentError";
  }
}

function normalizedRelativePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    path.posix.normalize(value) !== value
  ) {
    throw new WorkspaceContentError("invalid_input", "Workspace path is invalid");
  }
  const components = value.split("/");
  if (
    components.some(
      (component) =>
        component.length < 1 ||
        component === "." ||
        component === ".." ||
        component.toLocaleLowerCase("en-US") === ".git",
    )
  ) {
    throw new WorkspaceContentError("invalid_input", "Workspace path is invalid");
  }
  return value;
}

const EXCLUDED_WORKSPACE_COMPONENTS = new Set([
  "node_modules",
  ".ssh",
  ".aws",
  ".azure",
]);

function secretLikeWorkspaceComponent(component: string): boolean {
  const lower = component.toLocaleLowerCase("en-US");
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower === ".npmrc" ||
    lower === ".pypirc" ||
    lower === ".netrc" ||
    lower === ".git-credentials" ||
    lower === "id_rsa" ||
    lower === "id_ed25519" ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key") ||
    lower.endsWith(".p12") ||
    lower.endsWith(".pfx") ||
    lower === "credentials" ||
    lower === "credentials.json"
  );
}

function enginePrivateWorkspacePath(relativePath: string): boolean {
  const lower = relativePath.toLocaleLowerCase("en-US");
  if (!lower.startsWith(".zeros/")) return false;
  const rest = lower.slice(".zeros/".length);
  return (
    rest === "settings.local.toml" ||
    rest.startsWith("runtime/") ||
    rest.startsWith("credentials/") ||
    rest.startsWith("secrets/") ||
    rest.endsWith(".db") ||
    rest.endsWith(".db-wal") ||
    rest.endsWith(".db-shm") ||
    rest.endsWith(".sock") ||
    rest.endsWith(".socket")
  );
}

function durabilityIncludedWorkspacePath(relativePath: string): boolean {
  if (enginePrivateWorkspacePath(relativePath)) return false;
  return relativePath.split("/").every((component) => {
    const lower = component.toLocaleLowerCase("en-US");
    return (
      !EXCLUDED_WORKSPACE_COMPONENTS.has(lower) &&
      !secretLikeWorkspaceComponent(component)
    );
  });
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

function validateJsonDocument(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): void {
  state.nodes += 1;
  if (state.nodes > 20_000 || depth > 32) {
    throw new WorkspaceContentError(
      "invalid_input",
      "Checkpoint inclusion policy is too complex",
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJsonDocument(item, state, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") {
    throw new WorkspaceContentError(
      "invalid_input",
      "Checkpoint inclusion policy is invalid",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkspaceContentError(
      "invalid_input",
      "Checkpoint inclusion policy is invalid",
    );
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      key.length < 1 ||
      key.length > 256 ||
      ["__proto__", "constructor", "prototype"].includes(key)
    ) {
      throw new WorkspaceContentError(
        "invalid_input",
        "Checkpoint inclusion policy is invalid",
      );
    }
    validateJsonDocument(entry, state, depth + 1);
  }
}

function sameHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function fileEntryReferenceId(workspaceId: string, normalizedPath: string): string {
  return `${workspaceId}:${createHash("sha256")
    .update(normalizedPath, "utf8")
    .digest("hex")}`;
}

function isPgError(
  value: unknown,
): value is { code: string; constraint?: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "code" in value &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

export function validateWorkspaceFileMutations(
  input: readonly WorkspaceFileMutation[],
): WorkspaceFileMutation[] {
  if (input.length > MAX_WORKSPACE_FILE_MUTATIONS) {
    throw new WorkspaceContentError("invalid_input", "File mutation count is invalid");
  }
  const paths = new Set<string>();
  const portablePaths = new Set<string>();
  const validated = input.map((entry) => {
    const normalized = normalizedRelativePath(entry.path);
    const portable = normalized.normalize("NFKC").toLocaleLowerCase("en-US");
    if (paths.has(normalized) || portablePaths.has(portable)) {
      throw new WorkspaceContentError("invalid_input", "A path occurs more than once");
    }
    paths.add(normalized);
    portablePaths.add(portable);
    // Deletes remain legal for excluded paths so a newer engine can purge a
    // projection written by an older policy version. New secret/cache bytes
    // may never cross the sandbox trust boundary.
    if (entry.operation === "delete") {
      return { operation: "delete" as const, path: normalized };
    }
    if (
      !durabilityIncludedWorkspacePath(normalized) ||
      !["file", "symlink"].includes(entry.entryType) ||
      ![33188, 33261, 40960].includes(entry.mode) ||
      (entry.entryType === "symlink" && entry.mode !== 40960) ||
      (entry.entryType === "file" && entry.mode === 40960) ||
      !UUID_PATTERN.test(entry.blobId) ||
      !SHA256_PATTERN.test(entry.contentSha256) ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      entry.sizeBytes > MAX_WORKSPACE_FILE_BYTES ||
      (entry.entryType === "symlink" &&
        (entry.sizeBytes < 1 || entry.sizeBytes > MAX_WORKSPACE_SYMLINK_BYTES))
    ) {
      throw new WorkspaceContentError("invalid_input", "File mutation is invalid");
    }
    return { ...entry, path: normalized };
  });
  const livePortablePaths = validated
    .filter((entry) => entry.operation === "upsert")
    .map((entry) => entry.path.normalize("NFKC").toLocaleLowerCase("en-US"))
    .sort();
  for (let index = 1; index < livePortablePaths.length; index += 1) {
    const previous = livePortablePaths[index - 1]!;
    if (livePortablePaths[index]!.startsWith(`${previous}/`)) {
      throw new WorkspaceContentError(
        "invalid_input",
        "Workspace paths collide as a file and directory",
      );
    }
  }
  return validated;
}

async function addBlobReference(
  tx: Tx,
  input: {
    blobId: string;
    organizationId: string;
    workspaceId: string;
    kind:
      | "file_entry"
      | "file_event"
      | "checkpoint_manifest"
      | "checkpoint_artifact";
    referenceId: string;
  },
): Promise<void> {
  const inserted = await tx.query(
    `INSERT INTO workspace_blob_references (
       blob_id, org_id, workspace_id, reference_kind, reference_id
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [
      input.blobId,
      input.organizationId,
      input.workspaceId,
      input.kind,
      input.referenceId,
    ],
  );
  if ((inserted.rowCount ?? 0) > 0) {
    await tx.query(
      `UPDATE workspace_blobs
       SET reference_count = reference_count + 1
       WHERE id = $1 AND org_id = $2`,
      [input.blobId, input.organizationId],
    );
  }
}

async function removeBlobReference(
  tx: Tx,
  input: {
    blobId: string;
    organizationId: string;
    kind: "file_entry";
    referenceId: string;
  },
): Promise<void> {
  const removed = await tx.query(
    `DELETE FROM workspace_blob_references
     WHERE blob_id = $1 AND org_id = $2
       AND reference_kind = $3 AND reference_id = $4`,
    [input.blobId, input.organizationId, input.kind, input.referenceId],
  );
  if ((removed.rowCount ?? 0) > 0) {
    await tx.query(
      `UPDATE workspace_blobs
       SET reference_count = reference_count - 1
       WHERE id = $1 AND org_id = $2 AND reference_count > 0`,
      [input.blobId, input.organizationId],
    );
  }
}

export class DatabaseCloudWorkspaceContentService {
  private readonly pool: pg.Pool;
  private readonly workosEnabled: boolean;

  constructor(input: { pool: pg.Pool; workosEnabled: boolean }) {
    this.pool = input.pool;
    this.workosEnabled = input.workosEnabled;
  }

  async append(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    engineInstanceId: string;
    heartbeatToken: string;
    expectedRevision: number;
    idempotencyKey: string;
    gitBaseCommit: string | null;
    gitHeadRef: string | null;
    mutations: readonly WorkspaceFileMutation[];
  }): Promise<{ revision: number; replayed: boolean }> {
    if (
      !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      (input.gitBaseCommit !== null && !COMMIT_PATTERN.test(input.gitBaseCommit)) ||
      (input.gitHeadRef !== null &&
        (input.gitHeadRef.length < 1 || input.gitHeadRef.length > 512))
    ) {
      throw new WorkspaceContentError("invalid_input", "Content append input is invalid");
    }
    const mutations = validateWorkspaceFileMutations(input.mutations);
    const digest = createHash("sha256")
      .update(
        canonicalJson({
          expectedRevision: input.expectedRevision,
          gitBaseCommit: input.gitBaseCommit,
          gitHeadRef: input.gitHeadRef,
          mutations,
        }),
      )
      .digest();
    try {
      return await withSystemTx(this.pool, async (tx) => {
        const authority = await assertCurrentCloudEngineAuthority(tx, {
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: input.generation,
          engineInstanceId: input.engineInstanceId,
          heartbeatToken: input.heartbeatToken,
          workosEnabled: this.workosEnabled,
        });
        await tx.query(
          `INSERT INTO workspace_content_heads (workspace_id, org_id)
           VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING`,
          [input.workspaceId, input.organizationId],
        );
        const head = await tx.query<{ current_revision: string | number }>(
          `SELECT current_revision FROM workspace_content_heads
           WHERE workspace_id = $1 AND org_id = $2 FOR UPDATE`,
          [input.workspaceId, input.organizationId],
        );
        const current = Number(head.rows[0]?.current_revision);
        const prior = await tx.query<{
          revision: string | number;
          request_sha256: Buffer;
        }>(
          `SELECT revision, request_sha256
           FROM workspace_content_revisions
           WHERE workspace_id = $1 AND idempotency_key = $2`,
          [input.workspaceId, input.idempotencyKey],
        );
        if (prior.rows[0]) {
          if (!sameHash(prior.rows[0].request_sha256, digest)) {
            throw new WorkspaceContentError(
              "idempotency_conflict",
              "Content idempotency key was reused",
            );
          }
          return { revision: Number(prior.rows[0].revision), replayed: true };
        }
        if (current !== input.expectedRevision) {
          throw new WorkspaceContentError(
            "revision_conflict",
            "Content revision does not match the durable head",
          );
        }

        const upserts = mutations.filter(
          (mutation): mutation is Extract<WorkspaceFileMutation, { operation: "upsert" }> =>
            mutation.operation === "upsert",
        );
        if (upserts.length > 0) {
          const blobs = await tx.query<{
            id: string;
            plaintext_sha256: Buffer;
            plaintext_bytes: string | number;
          }>(
            `SELECT id, plaintext_sha256, plaintext_bytes
             FROM workspace_blobs
             WHERE org_id = $1 AND state = 'available'
               AND id = ANY($2::uuid[])
             FOR SHARE`,
            [input.organizationId, upserts.map((entry) => entry.blobId)],
          );
          const byId = new Map(blobs.rows.map((blob) => [blob.id, blob]));
          if (
            byId.size !== new Set(upserts.map((entry) => entry.blobId)).size ||
            upserts.some((entry) => {
              const blob = byId.get(entry.blobId);
              return (
                !blob ||
                blob.plaintext_sha256.toString("hex") !== entry.contentSha256 ||
                Number(blob.plaintext_bytes) !== entry.sizeBytes
              );
            })
          ) {
            throw new WorkspaceContentError(
              "blob_unavailable",
              "A content blob is unavailable or does not match",
            );
          }

          const proposedPortablePaths = upserts.map((entry) =>
            entry.path.normalize("NFKC").toLocaleLowerCase("en-US"),
          );
          const proposedAncestorPaths = [
            ...new Set(
              proposedPortablePaths.flatMap((entry) => {
                const components = entry.split("/");
                return components
                  .slice(0, -1)
                  .map((_, index) => components.slice(0, index + 1).join("/"));
              }),
            ),
          ];
          const changedPaths = mutations.map((entry) => entry.path);
          const hierarchyCollision = await tx.query(
            `WITH proposed(portable_path_key) AS (
               SELECT unnest($2::text[])
             ), collision AS (
               SELECT 1
               FROM workspace_file_entries existing
               WHERE existing.workspace_id = $1
                 AND existing.tombstoned_at IS NULL
                 AND existing.normalized_path <> ALL($3::text[])
                 AND existing.portable_path_key = ANY($4::text[])
               LIMIT 1
             )
             SELECT 1 FROM collision
             UNION ALL
             SELECT 1
             FROM proposed
             JOIN LATERAL (
               SELECT 1
               FROM workspace_file_entries existing
               WHERE existing.workspace_id = $1
                 AND existing.tombstoned_at IS NULL
                 AND existing.normalized_path <> ALL($3::text[])
                 AND existing.portable_path_key COLLATE "C" >=
                     (proposed.portable_path_key || '/') COLLATE "C"
                 AND existing.portable_path_key COLLATE "C" <
                     (proposed.portable_path_key || '0') COLLATE "C"
               LIMIT 1
             ) descendant ON true
             LIMIT 1`,
            [
              input.workspaceId,
              proposedPortablePaths,
              changedPaths,
              proposedAncestorPaths,
            ],
          );
          if ((hierarchyCollision.rowCount ?? 0) !== 0) {
            throw new WorkspaceContentError(
              "invalid_input",
              "Workspace paths collide as a file and directory",
            );
          }
        }

        const revision = current + 1;
        await tx.query(
          `INSERT INTO workspace_content_revisions (
             workspace_id, org_id, revision, parent_revision, authority_epoch,
             generation, engine_instance_id, idempotency_key, request_sha256,
             git_base_commit, git_head_ref, changed_entry_count
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            input.workspaceId,
            input.organizationId,
            revision,
            current,
            authority.authorityEpoch,
            input.generation,
            input.engineInstanceId,
            input.idempotencyKey,
            digest,
            input.gitBaseCommit,
            input.gitHeadRef,
            mutations.length,
          ],
        );
        for (const [index, mutation] of mutations.entries()) {
          const sequence = index + 1;
          const previous = await tx.query<{ blob_id: string | null }>(
            `SELECT blob_id FROM workspace_file_entries
             WHERE workspace_id = $1 AND normalized_path = $2 FOR UPDATE`,
            [input.workspaceId, mutation.path],
          );
          const previousBlob = previous.rows[0]?.blob_id;
          if (previousBlob) {
            await removeBlobReference(tx, {
              blobId: previousBlob,
              organizationId: input.organizationId,
              kind: "file_entry",
              referenceId: fileEntryReferenceId(
                input.workspaceId,
                mutation.path,
              ),
            });
            const legacyReferenceId = `${input.workspaceId}:${mutation.path}`;
            if (Buffer.byteLength(legacyReferenceId, "utf8") <= 512) {
              await removeBlobReference(tx, {
                blobId: previousBlob,
                organizationId: input.organizationId,
                kind: "file_entry",
                referenceId: legacyReferenceId,
              });
            }
          }
          await tx.query(
            `INSERT INTO workspace_file_events (
               workspace_id, org_id, revision, sequence, normalized_path,
               operation, entry_type, mode, blob_id, content_sha256, size_bytes
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            mutation.operation === "upsert"
              ? [
                  input.workspaceId,
                  input.organizationId,
                  revision,
                  sequence,
                  mutation.path,
                  mutation.operation,
                  mutation.entryType,
                  mutation.mode,
                  mutation.blobId,
                  Buffer.from(mutation.contentSha256, "hex"),
                  mutation.sizeBytes,
                ]
              : [
                  input.workspaceId,
                  input.organizationId,
                  revision,
                  sequence,
                  mutation.path,
                  mutation.operation,
                  null,
                  null,
                  null,
                  null,
                  null,
                ],
          );
          await tx.query(
            `INSERT INTO workspace_file_entries (
               workspace_id, org_id, normalized_path, revision, entry_type,
               mode, blob_id, content_sha256, size_bytes, tombstoned_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (workspace_id, normalized_path) DO UPDATE SET
               revision = EXCLUDED.revision,
               entry_type = EXCLUDED.entry_type,
               mode = EXCLUDED.mode,
               blob_id = EXCLUDED.blob_id,
               content_sha256 = EXCLUDED.content_sha256,
               size_bytes = EXCLUDED.size_bytes,
               tombstoned_at = EXCLUDED.tombstoned_at,
               updated_at = now()`,
            mutation.operation === "upsert"
              ? [
                  input.workspaceId,
                  input.organizationId,
                  mutation.path,
                  revision,
                  mutation.entryType,
                  mutation.mode,
                  mutation.blobId,
                  Buffer.from(mutation.contentSha256, "hex"),
                  mutation.sizeBytes,
                  null,
                ]
              : [
                  input.workspaceId,
                  input.organizationId,
                  mutation.path,
                  revision,
                  null,
                  null,
                  null,
                  null,
                  null,
                  new Date(),
                ],
          );
          if (mutation.operation === "upsert") {
            await addBlobReference(tx, {
              blobId: mutation.blobId,
              organizationId: input.organizationId,
              workspaceId: input.workspaceId,
              kind: "file_event",
              referenceId: `${input.workspaceId}:${revision}:${sequence}`,
            });
            await addBlobReference(tx, {
              blobId: mutation.blobId,
              organizationId: input.organizationId,
              workspaceId: input.workspaceId,
              kind: "file_entry",
              referenceId: fileEntryReferenceId(
                input.workspaceId,
                mutation.path,
              ),
            });
          }
        }
        await tx.query(
          `UPDATE workspace_content_heads
           SET current_revision = $2, updated_at = now()
           WHERE workspace_id = $1`,
          [input.workspaceId, revision],
        );
        await tx.query(
          `INSERT INTO cloud_workspace_outbox (
             org_id, workspace_id, event_type, aggregate_key,
             aggregate_revision, idempotency_key, payload
           ) VALUES ($1, $2, 'workspace.content_appended', $3, $4, $5, $6::jsonb)`,
          [
            input.organizationId,
            input.workspaceId,
            `workspace-content:${input.workspaceId}`,
            revision,
            `content:${input.workspaceId}:${input.idempotencyKey}`,
            JSON.stringify({
              workspaceId: input.workspaceId,
              revision,
              changedEntryCount: mutations.length,
              authorityEpoch: authority.authorityEpoch,
            }),
          ],
        );
        return { revision, replayed: false };
      });
    } catch (error) {
      if (error instanceof WorkspaceContentError) throw error;
      if (
        isPgError(error) &&
        error.code === "23505" &&
        error.constraint === "workspace_file_entries_portable_live_unique"
      ) {
        throw new WorkspaceContentError(
          "invalid_input",
          "Workspace paths collide on a supported local filesystem",
        );
      }
      if (
        error instanceof Error &&
        error.name === "CloudWorkspaceEngineAuthorityError"
      ) {
        throw new WorkspaceContentError(
          "engine_authority_rejected",
          "Content append authority is not current",
        );
      }
      throw error;
    }
  }

  async commitCheckpoint(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    engineInstanceId: string;
    heartbeatToken: string;
    requestId?: string;
    idempotencyKey: string;
    contentRevision: number;
    reason:
      | "periodic"
      | "before_stop"
      | "before_archive"
      | "before_delete"
      | "before_fork"
      | "before_rebuild"
      | "manual"
      | "recovery";
    manifestBlobId: string;
    artifactBlobId: string | null;
    inclusionPolicy: Record<string, unknown>;
    fileCount: number;
    totalBytes: number;
    integritySha256: string;
  }): Promise<{
    checkpointId: string;
    contentRevision: number;
    replayed: boolean;
  }> {
    validateJsonDocument(input.inclusionPolicy, { nodes: 0 });
    const canonicalInclusionPolicy = canonicalJson(input.inclusionPolicy);
    if (
      !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
      (input.requestId !== undefined && !UUID_PATTERN.test(input.requestId)) ||
      !Number.isSafeInteger(input.contentRevision) ||
      input.contentRevision < 1 ||
      !Number.isSafeInteger(input.fileCount) ||
      input.fileCount < 0 ||
      input.fileCount > 1_000_000 ||
      !Number.isSafeInteger(input.totalBytes) ||
      input.totalBytes < 0 ||
      input.totalBytes > 10 * 1024 * 1024 * 1024 ||
      !SHA256_PATTERN.test(input.integritySha256) ||
      !UUID_PATTERN.test(input.manifestBlobId) ||
      (input.artifactBlobId !== null && !UUID_PATTERN.test(input.artifactBlobId)) ||
      Buffer.byteLength(canonicalInclusionPolicy, "utf8") > 128 * 1024
    ) {
      throw new WorkspaceContentError("invalid_input", "Checkpoint input is invalid");
    }
    const digest = createHash("sha256")
      .update(
        canonicalJson({
          generation: input.generation,
          requestId: input.requestId ?? null,
          contentRevision: input.contentRevision,
          reason: input.reason,
          manifestBlobId: input.manifestBlobId,
          artifactBlobId: input.artifactBlobId,
          inclusionPolicy: JSON.parse(canonicalInclusionPolicy),
          fileCount: input.fileCount,
          totalBytes: input.totalBytes,
          integritySha256: input.integritySha256,
        }),
      )
      .digest();
    try {
      return await withSystemTx(this.pool, async (tx) => {
        const engineIdentity = {
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: input.generation,
          engineInstanceId: input.engineInstanceId,
          heartbeatToken: input.heartbeatToken,
        };
        await assertCloudEngineIdentityForIdempotentReplay(tx, engineIdentity);
        const prior = await tx.query<{
          id: string;
          content_revision: string | number;
          request_sha256: Buffer;
        }>(
          `SELECT id, content_revision, request_sha256
           FROM workspace_checkpoints
           WHERE workspace_id = $1 AND idempotency_key = $2`,
          [input.workspaceId, input.idempotencyKey],
        );
        if (prior.rows[0]) {
          if (!sameHash(prior.rows[0].request_sha256, digest)) {
            throw new WorkspaceContentError(
              "idempotency_conflict",
              "Checkpoint idempotency key was reused",
            );
          }
          if (input.requestId) {
            const completed = await tx.query(
              `SELECT 1 FROM workspace_checkpoint_requests
               WHERE id = $1 AND checkpoint_id = $2
                 AND workspace_id = $3 AND org_id = $4 AND generation = $5
                 AND reason = $6 AND state = 'succeeded'`,
              [
                input.requestId,
                prior.rows[0].id,
                input.workspaceId,
                input.organizationId,
                input.generation,
                input.reason,
              ],
            );
            if ((completed.rowCount ?? 0) !== 1) {
              throw new WorkspaceContentError(
                "checkpoint_request_rejected",
                "Checkpoint request is no longer current",
              );
            }
          }
          return {
            checkpointId: prior.rows[0].id,
            contentRevision: Number(prior.rows[0].content_revision),
            replayed: true,
          };
        }
        const authority = await assertCurrentCloudEngineAuthority(tx, {
          ...engineIdentity,
          workosEnabled: this.workosEnabled,
        });
        const head = await tx.query<{
          current_revision: string | number;
        }>(
          `SELECT current_revision FROM workspace_content_heads
           WHERE workspace_id = $1 AND org_id = $2 FOR UPDATE`,
          [input.workspaceId, input.organizationId],
        );
        if (Number(head.rows[0]?.current_revision) !== input.contentRevision) {
          throw new WorkspaceContentError(
            "revision_conflict",
            "Checkpoint is not at the current content revision",
          );
        }
      const blobIds = [input.manifestBlobId, input.artifactBlobId].filter(
        (value): value is string => value !== null,
      );
      const blobs = await tx.query<{
        id: string;
        plaintext_sha256: Buffer;
      }>(
        `SELECT id, plaintext_sha256 FROM workspace_blobs
         WHERE org_id = $1 AND state = 'available' AND id = ANY($2::uuid[])
         FOR SHARE`,
        [input.organizationId, blobIds],
      );
      if (new Set(blobs.rows.map((row) => row.id)).size !== new Set(blobIds).size) {
        throw new WorkspaceContentError(
          "blob_unavailable",
          "Checkpoint blob is unavailable",
        );
      }
      const manifest = blobs.rows.find((row) => row.id === input.manifestBlobId);
      if (
        !manifest ||
        manifest.plaintext_sha256.toString("hex") !== input.integritySha256
      ) {
        throw new WorkspaceContentError(
          "checkpoint_not_durable",
          "Checkpoint integrity does not match its manifest",
        );
      }
      const projected = await tx.query<{
        file_count: number;
        total_bytes: string | number;
      }>(
        `SELECT count(*)::integer AS file_count,
                coalesce(sum(size_bytes), 0)::bigint AS total_bytes
         FROM workspace_file_entries
         WHERE workspace_id = $1 AND org_id = $2 AND tombstoned_at IS NULL`,
        [input.workspaceId, input.organizationId],
      );
      if (
        projected.rows[0]?.file_count !== input.fileCount ||
        Number(projected.rows[0]?.total_bytes) !== input.totalBytes
      ) {
        throw new WorkspaceContentError(
          "checkpoint_not_durable",
          "Checkpoint counts do not match the durable file projection",
        );
      }
      const record = await tx.query<{ current_revision: string | number }>(
        `SELECT current_revision FROM workspace_record_heads
         WHERE workspace_id = $1 AND org_id = $2 FOR SHARE`,
        [input.workspaceId, input.organizationId],
      );
      const content = await tx.query<{
        git_base_commit: string | null;
        git_head_ref: string | null;
      }>(
        `SELECT git_base_commit, git_head_ref
         FROM workspace_content_revisions
         WHERE workspace_id = $1 AND org_id = $2 AND revision = $3`,
        [input.workspaceId, input.organizationId, input.contentRevision],
      );
      if (!content.rows[0]) {
        throw new WorkspaceContentError(
          "revision_conflict",
          "Checkpoint content revision is unavailable",
        );
      }
        const occupiedSlot = await tx.query<{ id: string }>(
          `SELECT id FROM workspace_checkpoints
           WHERE workspace_id = $1 AND content_revision = $2 AND reason = $3`,
          [input.workspaceId, input.contentRevision, input.reason],
        );
        if (occupiedSlot.rows[0]) {
          throw new WorkspaceContentError(
            "idempotency_conflict",
            "Checkpoint revision and reason are already recorded",
          );
        }
        const checkpoint = await tx.query<{ id: string }>(
        `INSERT INTO workspace_checkpoints (
           workspace_id, org_id, idempotency_key, request_sha256,
           content_revision, record_revision,
           authority_epoch, generation, reason, git_base_commit, git_head_ref,
           manifest_blob_id, artifact_blob_id, inclusion_policy, file_count,
           total_bytes, state, integrity_sha256, created_by, durable_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14::jsonb, $15, $16, 'durable', $17, $18, now()
         )
         RETURNING id`,
        [
          input.workspaceId,
          input.organizationId,
          input.idempotencyKey,
          digest,
          input.contentRevision,
          Number(record.rows[0]?.current_revision ?? 0),
          authority.authorityEpoch,
          input.generation,
          input.reason,
          content.rows[0].git_base_commit,
          content.rows[0].git_head_ref,
          input.manifestBlobId,
          input.artifactBlobId,
          canonicalInclusionPolicy,
          input.fileCount,
          input.totalBytes,
          Buffer.from(input.integritySha256, "hex"),
          authority.accountUserId,
        ],
        );
        const checkpointId = checkpoint.rows[0]!.id;
        const checkpointEntries = await tx.query(
          `INSERT INTO workspace_checkpoint_entries (
             checkpoint_id, workspace_id, org_id, normalized_path,
             operation, entry_type, mode, blob_id, content_sha256, size_bytes
           )
           SELECT $1, workspace_id, org_id, normalized_path,
                  CASE WHEN tombstoned_at IS NULL THEN 'upsert' ELSE 'delete' END,
                  entry_type, mode, blob_id, content_sha256, size_bytes
           FROM workspace_file_entries
           WHERE workspace_id = $2 AND org_id = $3`,
          [checkpointId, input.workspaceId, input.organizationId],
        );
        const snapshottedFiles = await tx.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM workspace_checkpoint_entries
           WHERE checkpoint_id = $1 AND operation = 'upsert'`,
          [checkpointId],
        );
        if (snapshottedFiles.rows[0]?.count !== input.fileCount) {
          throw new WorkspaceContentError(
            "checkpoint_not_durable",
            "Checkpoint projection changed while it was being committed",
          );
        }
        await tx.query(
          `WITH inserted AS (
             INSERT INTO workspace_blob_references (
               blob_id, org_id, workspace_id, reference_kind, reference_id
             )
             SELECT DISTINCT blob_id, org_id, workspace_id,
                    'checkpoint_file', $1::text
             FROM workspace_checkpoint_entries
             WHERE checkpoint_id = $1::uuid AND blob_id IS NOT NULL
             ON CONFLICT DO NOTHING
             RETURNING blob_id, org_id
           ), increments AS (
             SELECT blob_id, org_id, count(*)::bigint AS amount
             FROM inserted GROUP BY blob_id, org_id
           )
           UPDATE workspace_blobs blob
           SET reference_count = blob.reference_count + increments.amount
           FROM increments
           WHERE blob.id = increments.blob_id AND blob.org_id = increments.org_id`,
          [checkpointId],
        );
      if (input.requestId) {
        try {
          await completeWorkspaceCheckpointRequest(tx, {
            requestId: input.requestId,
            workspaceId: input.workspaceId,
            organizationId: input.organizationId,
            generation: input.generation,
            reason: input.reason,
            checkpointId,
          });
        } catch {
          throw new WorkspaceContentError(
            "checkpoint_request_rejected",
            "Checkpoint request is no longer current",
          );
        }
      }
      await addBlobReference(tx, {
        blobId: input.manifestBlobId,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        kind: "checkpoint_manifest",
        referenceId: checkpointId,
      });
      if (input.artifactBlobId) {
        await addBlobReference(tx, {
          blobId: input.artifactBlobId,
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          kind: "checkpoint_artifact",
          referenceId: checkpointId,
        });
      }
      await tx.query(
        `UPDATE workspace_content_heads
         SET durable_revision = $2, current_checkpoint_id = $3,
             last_durable_at = now(), updated_at = now()
         WHERE workspace_id = $1`,
        [input.workspaceId, input.contentRevision, checkpointId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_outbox (
           org_id, workspace_id, event_type, aggregate_key,
           aggregate_revision, idempotency_key, payload
         ) VALUES ($1, $2, 'workspace.checkpoint_durable', $3, $4, $5, $6::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          input.organizationId,
          input.workspaceId,
          `workspace-checkpoint:${input.workspaceId}`,
          input.contentRevision,
          `checkpoint:${checkpointId}`,
          JSON.stringify({
            workspaceId: input.workspaceId,
            checkpointId,
            contentRevision: input.contentRevision,
            recordRevision: Number(record.rows[0]?.current_revision ?? 0),
            reason: input.reason,
            authorityEpoch: authority.authorityEpoch,
          }),
        ],
      );
      await audit(
        tx,
        input.organizationId,
        authority.accountUserId,
        "workspace.checkpoint_durable",
        {
          workspaceId: input.workspaceId,
          checkpointId,
          contentRevision: input.contentRevision,
          reason: input.reason,
          fileCount: input.fileCount,
          totalBytes: input.totalBytes,
        },
      );
        return {
          checkpointId,
          contentRevision: input.contentRevision,
          replayed: false,
        };
      });
    } catch (error) {
      if (error instanceof WorkspaceContentError) throw error;
      if (
        error instanceof Error &&
        error.name === "CloudWorkspaceEngineAuthorityError"
      ) {
        throw new WorkspaceContentError(
          "engine_authority_rejected",
          "Checkpoint authority is not current",
        );
      }
      throw error;
    }
  }

  async read(input: {
    workspaceId: string;
    organizationId: string;
    accountUserId: string;
    afterRevision: number;
    limit?: number;
  }): Promise<{
    currentRevision: number;
    durableRevision: number;
    minimumRetainedRevision: number;
    snapshotRequired: boolean;
    entries: Array<{
      path: string;
      revision: number;
      entryType: "file" | "symlink" | null;
      mode: number | null;
      blobId: string | null;
      contentSha256: string | null;
      sizeBytes: number | null;
      tombstonedAt: string | null;
    }>;
    events: Array<{
      revision: number;
      sequence: number;
      path: string;
      operation: "upsert" | "delete";
      entryType: "file" | "symlink" | null;
      mode: number | null;
      blobId: string | null;
      contentSha256: string | null;
      sizeBytes: number | null;
    }>;
    checkpoint: null | {
      id: string;
      contentRevision: number;
      recordRevision: number;
      manifestBlobId: string;
      artifactBlobId: string | null;
      integritySha256: string;
      fileCount: number;
      totalBytes: number;
    };
    hasMore: boolean;
  }> {
    const limit = input.limit ?? 200;
    if (
      !UUID_PATTERN.test(input.workspaceId) ||
      !UUID_PATTERN.test(input.organizationId) ||
      !UUID_PATTERN.test(input.accountUserId) ||
      !Number.isSafeInteger(input.afterRevision) ||
      input.afterRevision < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new HttpError(422, "invalid_input", "Content cursor is invalid");
    }
    return withSystemTx(this.pool, async (tx) => {
      const workspace = await tx.query<{
        team_id: string;
        owner_user_id: string;
      }>(
        `SELECT team_id, owner_user_id FROM cloud_workspaces
         WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
        [input.workspaceId, input.organizationId],
      );
      const scope = workspace.rows[0];
      if (!scope) throw new HttpError(404, "not_found", "Workspace not found");
      await authorizeCloudWorkspaceOperation(tx, {
        organizationId: input.organizationId,
        teamId: scope.team_id,
        actorUserId: input.accountUserId,
        billingOwnerUserId: scope.owner_user_id,
        workosEnabled: this.workosEnabled,
        requireWorkspaceOwner: true,
      });
      const head = await tx.query<{
        current_revision: string | number;
        durable_revision: string | number;
        minimum_retained_revision: string | number;
        current_checkpoint_id: string | null;
      }>(
        `SELECT current_revision, durable_revision,
                minimum_retained_revision, current_checkpoint_id
         FROM workspace_content_heads
         WHERE workspace_id = $1 AND org_id = $2 FOR SHARE`,
        [input.workspaceId, input.organizationId],
      );
      const currentRevision = Number(head.rows[0]?.current_revision ?? 0);
      const durableRevision = Number(head.rows[0]?.durable_revision ?? 0);
      const minimumRetainedRevision = Number(
        head.rows[0]?.minimum_retained_revision ?? 0,
      );
      if (input.afterRevision > currentRevision) {
        throw new HttpError(
          409,
          "content_cursor_ahead",
          "Content cursor is ahead of the durable head",
        );
      }
      const snapshotRequired = input.afterRevision < minimumRetainedRevision;
      const entries = snapshotRequired
        ? (
            await tx.query<{
              normalized_path: string;
              revision: string | number;
              entry_type: "file" | "symlink" | null;
              mode: number | null;
              blob_id: string | null;
              content_sha256: Buffer | null;
              size_bytes: string | number | null;
              tombstoned_at: Date | string | null;
            }>(
              `SELECT normalized_path, revision, entry_type, mode, blob_id,
                      content_sha256, size_bytes, tombstoned_at
               FROM workspace_file_entries
               WHERE workspace_id = $1 AND org_id = $2
               ORDER BY normalized_path COLLATE "C"`,
              [input.workspaceId, input.organizationId],
            )
          ).rows.map((row) => ({
            path: row.normalized_path,
            revision: Number(row.revision),
            entryType: row.entry_type,
            mode: row.mode,
            blobId: row.blob_id,
            contentSha256: row.content_sha256?.toString("hex") ?? null,
            sizeBytes:
              row.size_bytes === null ? null : Number(row.size_bytes),
            tombstonedAt:
              row.tombstoned_at === null
                ? null
                : new Date(row.tombstoned_at).toISOString(),
          }))
        : [];
      const startRevision = snapshotRequired
        ? currentRevision
        : input.afterRevision;
      const eventRows = (
        await tx.query<{
          revision: string | number;
          sequence: number;
          normalized_path: string;
          operation: "upsert" | "delete";
          entry_type: "file" | "symlink" | null;
          mode: number | null;
          blob_id: string | null;
          content_sha256: Buffer | null;
          size_bytes: string | number | null;
        }>(
          `SELECT revision, sequence, normalized_path, operation, entry_type,
                  mode, blob_id, content_sha256, size_bytes
           FROM workspace_file_events
           WHERE workspace_id = $1 AND org_id = $2 AND revision > $3
           ORDER BY revision, sequence
           LIMIT $4`,
          [input.workspaceId, input.organizationId, startRevision, limit + 1],
        )
      ).rows;
      const checkpointId = head.rows[0]?.current_checkpoint_id ?? null;
      const checkpoint = checkpointId
        ? (
            await tx.query<{
              id: string;
              content_revision: string | number;
              record_revision: string | number;
              manifest_blob_id: string;
              artifact_blob_id: string | null;
              integrity_sha256: Buffer;
              file_count: number;
              total_bytes: string | number;
            }>(
              `SELECT id, content_revision, record_revision, manifest_blob_id,
                      artifact_blob_id, integrity_sha256, file_count, total_bytes
               FROM workspace_checkpoints
               WHERE id = $1 AND workspace_id = $2 AND org_id = $3
                 AND state = 'durable'`,
              [checkpointId, input.workspaceId, input.organizationId],
            )
          ).rows[0]
        : undefined;
      const hasMore = eventRows.length > limit;
      return {
        currentRevision,
        durableRevision,
        minimumRetainedRevision,
        snapshotRequired,
        entries,
        events: eventRows.slice(0, limit).map((row) => ({
          revision: Number(row.revision),
          sequence: row.sequence,
          path: row.normalized_path,
          operation: row.operation,
          entryType: row.entry_type,
          mode: row.mode,
          blobId: row.blob_id,
          contentSha256: row.content_sha256?.toString("hex") ?? null,
          sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
        })),
        checkpoint: checkpoint
          ? {
              id: checkpoint.id,
              contentRevision: Number(checkpoint.content_revision),
              recordRevision: Number(checkpoint.record_revision),
              manifestBlobId: checkpoint.manifest_blob_id,
              artifactBlobId: checkpoint.artifact_blob_id,
              integritySha256: checkpoint.integrity_sha256.toString("hex"),
              fileCount: checkpoint.file_count,
              totalBytes: Number(checkpoint.total_bytes),
            }
          : null,
        hasMore,
      };
    });
  }

  async headForEngine(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    engineInstanceId: string;
    heartbeatToken: string;
    afterPath: string | null;
    limit?: number;
  }): Promise<{
    currentRevision: number;
    durableRevision: number;
    checkpointId: string | null;
    entries: Array<{
      path: string;
      operation: "upsert" | "delete";
      entryType: "file" | "symlink" | null;
      mode: 33188 | 33261 | 40960 | null;
      blobId: string | null;
      contentSha256: string | null;
      sizeBytes: number | null;
    }>;
    nextAfterPath: string | null;
  }> {
    const limit = input.limit ?? 1_000;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_000 ||
      (input.afterPath !== null &&
        (input.afterPath.length < 1 ||
          Buffer.byteLength(input.afterPath, "utf8") > 4_096 ||
          input.afterPath !== input.afterPath.normalize("NFC")))
    ) {
      throw new WorkspaceContentError("invalid_input", "Content cursor is invalid");
    }
    try {
      return await withSystemTx(this.pool, async (tx) => {
        await assertCurrentCloudEngineAuthority(tx, {
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: input.generation,
          engineInstanceId: input.engineInstanceId,
          heartbeatToken: input.heartbeatToken,
          workosEnabled: this.workosEnabled,
        });
        await tx.query(
          `INSERT INTO workspace_content_heads (workspace_id, org_id)
           VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING`,
          [input.workspaceId, input.organizationId],
        );
        const head = await tx.query<{
          current_revision: string | number;
          durable_revision: string | number;
          current_checkpoint_id: string | null;
        }>(
          `SELECT current_revision, durable_revision, current_checkpoint_id
           FROM workspace_content_heads
           WHERE workspace_id = $1 AND org_id = $2`,
          [input.workspaceId, input.organizationId],
        );
        const entries = await tx.query<{
          normalized_path: string;
          operation: "upsert" | "delete";
          entry_type: "file" | "symlink" | null;
          mode: 33188 | 33261 | 40960 | null;
          blob_id: string | null;
          content_sha256: Buffer | null;
          size_bytes: string | number | null;
        }>(
          `SELECT normalized_path,
                  CASE WHEN tombstoned_at IS NULL THEN 'upsert'
                       ELSE 'delete' END AS operation,
                  entry_type, mode, blob_id, content_sha256, size_bytes
           FROM workspace_file_entries
           WHERE workspace_id = $1 AND org_id = $2
             AND ($3::text IS NULL OR
                  normalized_path COLLATE "C" > ($3::text COLLATE "C"))
           ORDER BY normalized_path COLLATE "C"
           LIMIT $4`,
          [input.workspaceId, input.organizationId, input.afterPath, limit + 1],
        );
        const hasMore = entries.rows.length > limit;
        const page = entries.rows.slice(0, limit);
        return {
          currentRevision: Number(head.rows[0]!.current_revision),
          durableRevision: Number(head.rows[0]!.durable_revision),
          checkpointId: head.rows[0]!.current_checkpoint_id,
          entries: page.map((entry) => ({
            path: entry.normalized_path,
            operation: entry.operation,
            entryType: entry.entry_type,
            mode: entry.mode,
            blobId: entry.blob_id,
            contentSha256: entry.content_sha256?.toString("hex") ?? null,
            sizeBytes:
              entry.size_bytes === null ? null : Number(entry.size_bytes),
          })),
          nextAfterPath: hasMore ? page.at(-1)!.normalized_path : null,
        };
      });
    } catch (error) {
      if (error instanceof WorkspaceContentError) throw error;
      if (
        error instanceof Error &&
        error.name === "CloudWorkspaceEngineAuthorityError"
      ) {
        throw new WorkspaceContentError(
          "engine_authority_rejected",
          "Content head authority is not current",
        );
      }
      throw error;
    }
  }

  async readRecoveryCheckpointSystem(input: {
    workspaceId: string;
    organizationId: string;
  }): Promise<null | {
    checkpointId: string;
    contentRevision: number;
    recordRevision: number;
    generation: number;
    authorityEpoch: number;
    manifestBlobId: string;
    artifactBlobId: string | null;
    integritySha256: string;
    inclusionPolicy: Record<string, unknown>;
    fileCount: number;
    totalBytes: number;
    gitBaseCommit: string | null;
    gitHeadRef: string | null;
  }> {
    if (
      !UUID_PATTERN.test(input.workspaceId) ||
      !UUID_PATTERN.test(input.organizationId)
    ) {
      throw new WorkspaceContentError(
        "invalid_input",
        "Recovery checkpoint identity is invalid",
      );
    }
    return withSystemTx(this.pool, async (tx) => {
      const row = (
        await tx.query<{
          id: string;
          content_revision: string | number;
          record_revision: string | number;
          generation: number;
          authority_epoch: string | number;
          manifest_blob_id: string;
          artifact_blob_id: string | null;
          integrity_sha256: Buffer;
          inclusion_policy: Record<string, unknown>;
          file_count: number;
          total_bytes: string | number;
          git_base_commit: string | null;
          git_head_ref: string | null;
        }>(
          `SELECT checkpoint.id, checkpoint.content_revision,
                  checkpoint.record_revision, checkpoint.generation,
                  checkpoint.authority_epoch, checkpoint.manifest_blob_id,
                  checkpoint.artifact_blob_id, checkpoint.integrity_sha256,
                  checkpoint.inclusion_policy, checkpoint.file_count,
                  checkpoint.total_bytes, checkpoint.git_base_commit,
                  checkpoint.git_head_ref
           FROM workspace_content_heads head
           JOIN workspace_checkpoints checkpoint
             ON checkpoint.id = head.current_checkpoint_id
            AND checkpoint.workspace_id = head.workspace_id
            AND checkpoint.org_id = head.org_id
           JOIN cloud_workspaces workspace
             ON workspace.id = head.workspace_id AND workspace.org_id = head.org_id
           WHERE head.workspace_id = $1 AND head.org_id = $2
             AND checkpoint.state = 'durable' AND workspace.deleted_at IS NULL`,
          [input.workspaceId, input.organizationId],
        )
      ).rows[0];
      if (!row) return null;
      return {
        checkpointId: row.id,
        contentRevision: Number(row.content_revision),
        recordRevision: Number(row.record_revision),
        generation: row.generation,
        authorityEpoch: Number(row.authority_epoch),
        manifestBlobId: row.manifest_blob_id,
        artifactBlobId: row.artifact_blob_id,
        integritySha256: row.integrity_sha256.toString("hex"),
        inclusionPolicy: row.inclusion_policy,
        fileCount: row.file_count,
        totalBytes: Number(row.total_bytes),
        gitBaseCommit: row.git_base_commit,
        gitHeadRef: row.git_head_ref,
      };
    });
  }
}

export function workspacePathIsReplicaSafe(value: string): boolean {
  try {
    const normalized = normalizedRelativePath(value);
    return normalized === value && durabilityIncludedWorkspacePath(normalized);
  } catch {
    return false;
  }
}
