import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import path from "node:path";

import type pg from "pg";

import { audit } from "../audit.js";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import {
  authorizeCloudWorkspaceDataAccess,
  authorizeCloudWorkspaceOperation,
} from "./authorization.js";
import { enqueueWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import {
  validateWorkspaceFileMutations,
  WorkspaceContentError,
} from "./content-record.js";
import {
  WorkspaceBlobError,
  type DatabaseCloudWorkspaceBlobService,
} from "./object-store.js";
import {
  consumeCloudWorkspaceDeviceProof,
  type CloudWorkspaceDeviceProof,
  WorkspaceReplicaError,
} from "./replicas.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_IMPORT_ENTRIES = 250_000;
const MAX_IMPORT_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_IMPORT_RECORDS = 250_000;
const MAX_IMPORT_RECORD_BYTES = 512 * 1024 * 1024;

type WorkspaceForkImportLimits = {
  maxImportEntries: number;
  maxImportBytes: number;
  maxImportRecords: number;
  maxImportRecordBytes: number;
};

export type WorkspaceForkImportEntry =
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

export type WorkspaceForkImportRecord = {
  ordinal: number;
  entityKind:
    | "workspace"
    | "chat"
    | "message"
    | "turn"
    | "agent_session"
    | "run"
    | "terminal"
    | "design_transaction"
    | "metadata";
  entityId: string;
  operation: "upsert" | "tombstone";
  schemaVersion: number;
  document: Record<string, unknown> | null;
  occurredAt: string;
};

export class WorkspaceForkError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "not_found"
      | "not_ready"
      | "idempotency_conflict"
      | "blob_unavailable"
      | "import_conflict"
      | "export_unavailable"
      | "device_proof_rejected"
      | "device_proof_replayed"
      | "grant_rejected",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceForkError";
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
    path.posix.normalize(value) !== value ||
    value
      .split("/")
      .some(
        (component) =>
          component.length < 1 ||
          component === "." ||
          component === ".." ||
          component.toLocaleLowerCase("en-US") === ".git",
      )
  ) {
    throw new WorkspaceForkError("invalid_input", "Fork path is invalid");
  }
  return value;
}

function portableFolder(value: unknown): boolean {
  if (value === "." || value === null) return true;
  if (typeof value !== "string") return false;
  try {
    normalizedRelativePath(value);
    return true;
  } catch {
    return false;
  }
}

function compoundRecordId(prefix: "m" | "t", ...parts: string[]): string {
  return `${prefix}:${createHash("sha256").update(parts.join("\0"), "utf8").digest("hex")}`;
}

function forkedChatId(targetWorkspaceId: string, sourceChatId: string): string {
  return `chat_f_${createHash("sha256")
    .update("zeros-workspace-fork-chat-v1\0", "utf8")
    .update(targetWorkspaceId.toLowerCase(), "utf8")
    .update("\0", "utf8")
    .update(sourceChatId, "utf8")
    .digest("hex")
    .slice(0, 40)}`;
}

function natural(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Enforce the portable transcript boundary on the server. A custom client
 * cannot smuggle a native provider resume id, a host path, a Git snapshot id,
 * or an active run into a newly forked cloud workspace. */
function validatePortableImportRecord(
  targetWorkspaceId: string,
  record: WorkspaceForkImportRecord,
): void {
  if (
    !["chat", "message", "turn"].includes(record.entityKind) ||
    record.operation !== "upsert" ||
    record.schemaVersion !== 1 ||
    !record.document ||
    record.document.version !== 1
  ) {
    throw new WorkspaceForkError(
      "invalid_input",
      "Fork imports accept only portable chat history",
    );
  }
  if (record.entityKind === "chat") {
    const chat = record.document.chat;
    if (
      !chat ||
      typeof chat !== "object" ||
      Array.isArray(chat) ||
      typeof (chat as Record<string, unknown>).id !== "string" ||
      (chat as Record<string, unknown>).id !== record.entityId ||
      typeof (chat as Record<string, unknown>).sourceChatId !== "string" ||
      forkedChatId(
        targetWorkspaceId,
        (chat as Record<string, unknown>).sourceChatId as string,
      ) !== record.entityId ||
      !portableFolder((chat as Record<string, unknown>).folder) ||
      !Array.isArray((chat as Record<string, unknown>).additionalDirectories) ||
      ((chat as Record<string, unknown>).additionalDirectories as unknown[])
        .length !== 0 ||
      (chat as Record<string, unknown>).sessionId !== null ||
      (chat as Record<string, unknown>).providerBinding !== null ||
      (chat as Record<string, unknown>).providerMetadata !== null
    ) {
      throw new WorkspaceForkError(
        "invalid_input",
        "Fork chat record is not portable",
      );
    }
    return;
  }
  if (record.entityKind === "message") {
    const document = record.document;
    if (
      typeof document.chatId !== "string" ||
      typeof document.msgId !== "string" ||
      document.msgId.length < 1 ||
      compoundRecordId("m", document.chatId, document.msgId) !==
        record.entityId ||
      !natural(document.ord) ||
      typeof document.kind !== "string" ||
      typeof document.payload !== "string" ||
      !natural(document.createdAt)
    ) {
      throw new WorkspaceForkError(
        "invalid_input",
        "Fork message record is invalid",
      );
    }
    return;
  }
  const row = record.document.row;
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    typeof (row as Record<string, unknown>).chat_id !== "string" ||
    typeof (row as Record<string, unknown>).turn_id !== "string" ||
    compoundRecordId(
      "t",
      (row as Record<string, unknown>).chat_id as string,
      (row as Record<string, unknown>).turn_id as string,
    ) !== record.entityId ||
    !natural((row as Record<string, unknown>).ord) ||
    !natural((row as Record<string, unknown>).started_at) ||
    !["completed", "failed", "cancelled"].includes(
      String((row as Record<string, unknown>).status),
    ) ||
    !portableFolder((row as Record<string, unknown>).folder) ||
    (row as Record<string, unknown>).workspace_id !== null ||
    (row as Record<string, unknown>).pre_snapshot !== null ||
    (row as Record<string, unknown>).post_snapshot !== null
  ) {
    throw new WorkspaceForkError(
      "invalid_input",
      "Fork turn record is not portable",
    );
  }
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

function digest(value: unknown): Buffer {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest();
}

function same(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function validateJson(value: unknown, depth = 0, state = { nodes: 0 }): void {
  state.nodes += 1;
  if (depth > 32 || state.nodes > 20_000) {
    throw new WorkspaceForkError("invalid_input", "Fork record is too complex");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    for (const entry of value) validateJson(entry, depth + 1, state);
    return;
  }
  if (!value || typeof value !== "object") {
    throw new WorkspaceForkError("invalid_input", "Fork record is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkspaceForkError("invalid_input", "Fork record is invalid");
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      key.length < 1 ||
      key.length > 256 ||
      ["__proto__", "constructor", "prototype"].includes(key)
    ) {
      throw new WorkspaceForkError("invalid_input", "Fork record is invalid");
    }
    validateJson(entry, depth + 1, state);
  }
}

type ImportAuthority = {
  org_id: string;
  requested_by: string;
  target_cloud_workspace_id: string;
  source_local_workspace_id: string;
  source_revision: string | number;
  source_snapshot_sha256: Buffer | null;
  source_git_base_commit: string | null;
  source_git_head_ref: string | null;
  include_chats: boolean;
  state: string;
  team_id: string;
  owner_user_id: string;
};

type ExportGrantAuthority = {
  grant_id: string;
  device_id: string;
  device_key_version: string | number;
  export_id: string;
  export_manifest_blob_id: string;
  export_manifest_sha256: Buffer;
  source_cloud_workspace_id: string;
  source_checkpoint_id: string;
  target_local_workspace_id: string;
  include_chats: boolean;
  team_id: string;
  owner_user_id: string;
  repository_forge: string;
  repository_owner: string;
  repository_name: string;
  repository_revision: string;
  content_revision: string | number;
  record_revision: string | number;
  file_count: number;
  total_bytes: string | number;
  git_base_commit: string | null;
  git_head_ref: string | null;
  manifest_blob_id: string;
  integrity_sha256: Buffer;
};

async function lockImportAuthority(
  tx: Tx,
  input: {
    forkIntentId: string;
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    allowedStates: readonly string[];
    workosEnabled: boolean;
  },
): Promise<ImportAuthority> {
  const row = (
    await tx.query<ImportAuthority>(
      `SELECT fork.org_id, fork.requested_by,
              fork.target_cloud_workspace_id,
              source_local_workspace_id, source_revision,
              source_snapshot_sha256,
              source_git_base_commit, source_git_head_ref, include_chats,
              fork.state, workspace.team_id, workspace.owner_user_id
       FROM workspace_fork_intents fork
       JOIN cloud_workspaces workspace
         ON workspace.id = fork.target_cloud_workspace_id
        AND workspace.org_id = fork.org_id
       WHERE fork.id = $1 AND fork.org_id = $2
         AND fork.target_cloud_workspace_id = $3
         AND fork.requested_by = $4 AND fork.operation = 'local_to_cloud'
         AND workspace.deleted_at IS NULL
       FOR UPDATE OF fork, workspace`,
      [
        input.forkIntentId,
        input.organizationId,
        input.workspaceId,
        input.accountUserId,
      ],
    )
  ).rows[0];
  if (!row) throw new WorkspaceForkError("not_found", "Fork import not found");
  await authorizeCloudWorkspaceOperation(tx, {
    organizationId: input.organizationId,
    teamId: row.team_id,
    actorUserId: input.accountUserId,
    billingOwnerUserId: row.owner_user_id,
    workosEnabled: input.workosEnabled,
    requireWorkspaceOwner: true,
  });
  if (!input.allowedStates.includes(row.state)) {
    throw new WorkspaceForkError("not_ready", "Fork import is not writable");
  }
  return row;
}

async function addReferences(
  tx: Tx,
  input: {
    organizationId: string;
    workspaceId: string;
    kind: "fork_import" | "checkpoint_manifest" | "export";
    referenceId: string;
    blobIds: readonly string[];
  },
): Promise<void> {
  if (input.blobIds.length < 1) return;
  await tx.query(
    `WITH inserted AS (
       INSERT INTO workspace_blob_references (
         blob_id, org_id, workspace_id, reference_kind, reference_id
       )
       SELECT DISTINCT blob.id, $1::uuid, $2::uuid, $3::text, $4::text
       FROM workspace_blobs blob
       WHERE blob.org_id = $1::uuid AND blob.id = ANY($5::uuid[])
         AND (
           blob.state = 'available'
           OR ($3::text = 'fork_import' AND blob.state = 'pending_upload')
         )
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
    [
      input.organizationId,
      input.workspaceId,
      input.kind,
      input.referenceId,
      input.blobIds,
    ],
  );
}

async function releaseForkImportStaging(
  tx: Tx,
  input: {
    forkIntentId: string;
    organizationId: string;
    workspaceId: string;
  },
): Promise<void> {
  const removed = await tx.query<{ blob_id: string; org_id: string }>(
    `DELETE FROM workspace_blob_references
     WHERE workspace_id = $1 AND org_id = $2
       AND reference_kind = 'fork_import' AND reference_id = $3
     RETURNING blob_id, org_id`,
    [input.workspaceId, input.organizationId, input.forkIntentId],
  );
  for (const reference of removed.rows) {
    const decremented = await tx.query(
      `UPDATE workspace_blobs
       SET reference_count = reference_count - 1
       WHERE id = $1 AND org_id = $2 AND reference_count > 0`,
      [reference.blob_id, reference.org_id],
    );
    if ((decremented.rowCount ?? 0) !== 1) {
      throw new Error(
        "workspace fork object reference accounting is inconsistent",
      );
    }
  }
  await tx.query(
    `DELETE FROM workspace_fork_import_entries WHERE fork_intent_id = $1`,
    [input.forkIntentId],
  );
  await tx.query(
    `DELETE FROM workspace_fork_import_records WHERE fork_intent_id = $1`,
    [input.forkIntentId],
  );
}

async function localImportSnapshotSha256(
  tx: Tx,
  input: {
    forkIntentId: string;
    gitBaseCommit: string;
    gitHeadRef: string | null;
  },
): Promise<Buffer> {
  const fileHash = createHash("sha256")
    .update(input.gitBaseCommit, "utf8")
    .update("\0", "utf8")
    .update(input.gitHeadRef ?? "", "utf8")
    .update("\0", "utf8")
    .update("[", "utf8");
  let afterPath: string | null = null;
  let first = true;
  for (;;) {
    const page: pg.QueryResult<{
      normalized_path: string;
      entry_type: "file" | "symlink";
      mode: number;
      content_sha256: Buffer;
      size_bytes: string | number;
    }> = await tx.query(
      `SELECT normalized_path, entry_type, mode, content_sha256, size_bytes
       FROM workspace_fork_import_entries
       WHERE fork_intent_id = $1 AND operation = 'upsert'
         AND ($2::text IS NULL OR normalized_path COLLATE "C" > ($2::text COLLATE "C"))
       ORDER BY normalized_path COLLATE "C" LIMIT 1000`,
      [input.forkIntentId, afterPath],
    );
    for (const entry of page.rows) {
      if (!first) fileHash.update(",", "utf8");
      first = false;
      fileHash.update(
        JSON.stringify({
          path: entry.normalized_path,
          entryType: entry.entry_type,
          mode: entry.mode,
          contentSha256: entry.content_sha256.toString("hex"),
          sizeBytes: Number(entry.size_bytes),
        }),
        "utf8",
      );
    }
    if (page.rows.length < 1_000) break;
    afterPath = page.rows[page.rows.length - 1]!.normalized_path;
  }
  fileHash.update("]\0[", "utf8");
  afterPath = null;
  first = true;
  for (;;) {
    const page: pg.QueryResult<{ normalized_path: string }> = await tx.query(
      `SELECT normalized_path
       FROM workspace_fork_import_entries
       WHERE fork_intent_id = $1 AND operation = 'delete'
         AND ($2::text IS NULL OR normalized_path COLLATE "C" > ($2::text COLLATE "C"))
       ORDER BY normalized_path COLLATE "C" LIMIT 1000`,
      [input.forkIntentId, afterPath],
    );
    for (const entry of page.rows) {
      if (!first) fileHash.update(",", "utf8");
      first = false;
      fileHash.update(JSON.stringify(entry.normalized_path), "utf8");
    }
    if (page.rows.length < 1_000) break;
    afterPath = page.rows[page.rows.length - 1]!.normalized_path;
  }
  const fileFingerprint = fileHash.update("]", "utf8").digest("hex");
  const snapshot = createHash("sha256")
    .update("zeros-local-to-cloud-snapshot-v1\0", "utf8")
    .update(fileFingerprint, "utf8");
  let afterOrdinal = -1;
  for (;;) {
    const page = await tx.query<{
      ordinal: string | number;
      entity_kind: string;
      entity_id: string;
      document: unknown;
      occurred_at: Date;
    }>(
      `SELECT ordinal, entity_kind, entity_id, document, occurred_at
       FROM workspace_fork_import_records
       WHERE fork_intent_id = $1 AND ordinal > $2
       ORDER BY ordinal LIMIT 1000`,
      [input.forkIntentId, afterOrdinal],
    );
    for (const record of page.rows) {
      snapshot
        .update("\0", "utf8")
        .update(record.entity_kind, "utf8")
        .update("\0", "utf8")
        .update(record.entity_id, "utf8")
        .update("\0", "utf8")
        .update(record.occurred_at.toISOString(), "utf8")
        .update("\0", "utf8")
        .update(canonicalJson(record.document), "utf8");
    }
    if (page.rows.length < 1_000) break;
    afterOrdinal = Number(page.rows[page.rows.length - 1]!.ordinal);
  }
  return snapshot.digest();
}

export class DatabaseCloudWorkspaceForkService {
  private readonly limits: WorkspaceForkImportLimits;
  private readonly workosEnabled: boolean;

  constructor(
    private readonly pool: pg.Pool,
    private readonly blobs: DatabaseCloudWorkspaceBlobService,
    workosEnabled: boolean,
    limits: Partial<WorkspaceForkImportLimits> = {},
  ) {
    this.workosEnabled = workosEnabled;
    this.limits = {
      maxImportEntries: Math.min(
        limits.maxImportEntries ?? MAX_IMPORT_ENTRIES,
        MAX_IMPORT_ENTRIES,
      ),
      maxImportBytes: Math.min(
        limits.maxImportBytes ?? MAX_IMPORT_BYTES,
        MAX_IMPORT_BYTES,
      ),
      maxImportRecords: Math.min(
        limits.maxImportRecords ?? MAX_IMPORT_RECORDS,
        MAX_IMPORT_RECORDS,
      ),
      maxImportRecordBytes: Math.min(
        limits.maxImportRecordBytes ?? MAX_IMPORT_RECORD_BYTES,
        MAX_IMPORT_RECORD_BYTES,
      ),
    };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`cloud workspace fork ${name} is invalid`);
      }
    }
  }

  async uploadImportBlob(input: {
    forkIntentId: string;
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    bytes: Uint8Array;
  }) {
    try {
      return await this.blobs.putForForkImport(input, async (tx, blob) => {
        await lockImportAuthority(tx, {
          ...input,
          allowedStates: ["requested"],
          workosEnabled: this.workosEnabled,
        });
        await addReferences(tx, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          kind: "fork_import",
          referenceId: input.forkIntentId,
          blobIds: [blob.id],
        });
        const aggregate = await tx.query<{
          object_count: number;
          total_bytes: string | number;
        }>(
          `SELECT count(*)::integer AS object_count,
                  coalesce(sum(blob.plaintext_bytes), 0)::bigint AS total_bytes
           FROM workspace_blob_references reference
           JOIN workspace_blobs blob
             ON blob.id = reference.blob_id AND blob.org_id = reference.org_id
           WHERE reference.workspace_id = $1 AND reference.org_id = $2
             AND reference.reference_kind = 'fork_import'
             AND reference.reference_id = $3`,
          [input.workspaceId, input.organizationId, input.forkIntentId],
        );
        if (
          aggregate.rows[0]!.object_count > this.limits.maxImportEntries ||
          Number(aggregate.rows[0]!.total_bytes) > this.limits.maxImportBytes
        ) {
          throw new WorkspaceForkError(
            "invalid_input",
            "Fork upload exceeds its aggregate limits",
          );
        }
      });
    } catch (error) {
      if (error instanceof WorkspaceBlobError) {
        if (error.code === "invalid_input") {
          throw new WorkspaceForkError("invalid_input", "Fork blob is invalid");
        }
        if (error.code === "engine_authority_rejected") {
          throw new WorkspaceForkError(
            "not_ready",
            "Fork import is no longer writable",
          );
        }
        throw new WorkspaceForkError(
          "blob_unavailable",
          "Fork blob storage is unavailable",
        );
      }
      throw error;
    }
  }

  async stageImportEntries(input: {
    forkIntentId: string;
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    entries: readonly WorkspaceForkImportEntry[];
  }): Promise<{ accepted: number }> {
    if (input.entries.length < 1 || input.entries.length > 1_000) {
      throw new WorkspaceForkError(
        "invalid_input",
        "Fork entry batch is invalid",
      );
    }
    let entries: WorkspaceForkImportEntry[];
    try {
      entries = validateWorkspaceFileMutations(input.entries);
    } catch (error) {
      if (error instanceof WorkspaceContentError) {
        throw new WorkspaceForkError("invalid_input", error.message);
      }
      throw error;
    }
    await withSystemTx(this.pool, async (tx) => {
      await lockImportAuthority(tx, {
        ...input,
        allowedStates: ["requested"],
        workosEnabled: this.workosEnabled,
      });
      const proposedPortablePaths = entries
        .filter((entry) => entry.operation === "upsert")
        .map((entry) =>
          entry.path.normalize("NFKC").toLocaleLowerCase("en-US"),
        );
      if (proposedPortablePaths.length > 0) {
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
        const changedPaths = entries.map((entry) => entry.path);
        const hierarchyCollision = await tx.query(
          `WITH proposed(portable_path_key) AS (
             SELECT unnest($2::text[])
           ), collision AS (
             SELECT 1
             FROM workspace_fork_import_entries existing
             WHERE existing.fork_intent_id = $1
               AND existing.operation = 'upsert'
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
             FROM workspace_fork_import_entries existing
             WHERE existing.fork_intent_id = $1
               AND existing.operation = 'upsert'
               AND existing.normalized_path <> ALL($3::text[])
               AND existing.portable_path_key COLLATE "C" >=
                   (proposed.portable_path_key || '/') COLLATE "C"
               AND existing.portable_path_key COLLATE "C" <
                   (proposed.portable_path_key || '0') COLLATE "C"
             LIMIT 1
           ) descendant ON true
           LIMIT 1`,
          [
            input.forkIntentId,
            proposedPortablePaths,
            changedPaths,
            proposedAncestorPaths,
          ],
        );
        if ((hierarchyCollision.rowCount ?? 0) !== 0) {
          throw new WorkspaceForkError(
            "invalid_input",
            "Fork paths collide as a file and directory",
          );
        }
      }
      const verified = await tx.query<{
        id: string;
        plaintext_sha256: Buffer;
        plaintext_bytes: string | number;
      }>(
        `SELECT id, plaintext_sha256, plaintext_bytes
         FROM workspace_blobs
         WHERE org_id = $1 AND id = ANY($2::uuid[]) AND state = 'available'
         FOR SHARE`,
        [
          input.organizationId,
          entries
            .filter((entry) => entry.operation === "upsert")
            .map((entry) => entry.blobId),
        ],
      );
      const byId = new Map(verified.rows.map((row) => [row.id, row]));
      for (const entry of entries) {
        if (entry.operation === "upsert") {
          const blob = byId.get(entry.blobId);
          if (
            !blob ||
            Number(blob.plaintext_bytes) !== entry.sizeBytes ||
            blob.plaintext_sha256.toString("hex") !== entry.contentSha256
          ) {
            throw new WorkspaceForkError(
              "blob_unavailable",
              "Fork content blob is unavailable",
            );
          }
        }
        const inserted = await tx.query(
          `INSERT INTO workspace_fork_import_entries (
             fork_intent_id, org_id, target_workspace_id, normalized_path,
             operation, entry_type, mode, blob_id, content_sha256, size_bytes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING`,
          [
            input.forkIntentId,
            input.organizationId,
            input.workspaceId,
            entry.path,
            entry.operation,
            entry.operation === "upsert" ? entry.entryType : null,
            entry.operation === "upsert" ? entry.mode : null,
            entry.operation === "upsert" ? entry.blobId : null,
            entry.operation === "upsert"
              ? Buffer.from(entry.contentSha256, "hex")
              : null,
            entry.operation === "upsert" ? entry.sizeBytes : null,
          ],
        );
        if ((inserted.rowCount ?? 0) === 0) {
          const prior = await tx.query<{
            operation: "upsert" | "delete";
            entry_type: string | null;
            mode: number | null;
            blob_id: string | null;
            content_sha256: Buffer | null;
            size_bytes: string | number | null;
          }>(
            `SELECT operation, entry_type, mode, blob_id, content_sha256, size_bytes
             FROM workspace_fork_import_entries
             WHERE fork_intent_id = $1 AND normalized_path = $2`,
            [input.forkIntentId, entry.path],
          );
          const row = prior.rows[0];
          const matches =
            !!row &&
            row.operation === entry.operation &&
            (entry.operation === "delete"
              ? row.entry_type === null &&
                row.mode === null &&
                row.blob_id === null &&
                row.content_sha256 === null &&
                row.size_bytes === null
              : row.entry_type === entry.entryType &&
                row.mode === entry.mode &&
                row.blob_id === entry.blobId &&
                row.content_sha256?.toString("hex") === entry.contentSha256 &&
                Number(row.size_bytes) === entry.sizeBytes);
          if (!matches) {
            throw new WorkspaceForkError(
              "import_conflict",
              "Fork entry was already staged with different content",
            );
          }
        }
      }
      const aggregate = await tx.query<{
        entry_count: number;
        total_bytes: string | number;
      }>(
        `SELECT count(*)::integer AS entry_count,
                coalesce(sum(size_bytes), 0)::bigint AS total_bytes
         FROM workspace_fork_import_entries WHERE fork_intent_id = $1`,
        [input.forkIntentId],
      );
      if (
        aggregate.rows[0]!.entry_count > this.limits.maxImportEntries ||
        Number(aggregate.rows[0]!.total_bytes) > this.limits.maxImportBytes
      ) {
        throw new WorkspaceForkError(
          "invalid_input",
          "Fork entries exceed their aggregate limits",
        );
      }
      await addReferences(tx, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        kind: "fork_import",
        referenceId: input.forkIntentId,
        blobIds: entries
          .filter((entry) => entry.operation === "upsert")
          .map((entry) => entry.blobId),
      });
    });
    return { accepted: entries.length };
  }

  async stageImportRecords(input: {
    forkIntentId: string;
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    records: readonly WorkspaceForkImportRecord[];
  }): Promise<{ accepted: number }> {
    if (input.records.length < 1 || input.records.length > 20) {
      throw new WorkspaceForkError(
        "invalid_input",
        "Fork record batch is invalid",
      );
    }
    for (const record of input.records) {
      const occurredAt = new Date(record.occurredAt);
      if (
        !Number.isSafeInteger(record.ordinal) ||
        record.ordinal < 0 ||
        !Number.isSafeInteger(record.schemaVersion) ||
        record.schemaVersion < 1 ||
        record.schemaVersion > 65_535 ||
        record.entityId.length < 1 ||
        Buffer.byteLength(record.entityId, "utf8") > 255 ||
        /[\u0000-\u001f\u007f]/u.test(record.entityId) ||
        !Number.isFinite(occurredAt.getTime()) ||
        occurredAt.toISOString() !== record.occurredAt ||
        (record.operation === "upsert") !== (record.document !== null)
      ) {
        throw new WorkspaceForkError("invalid_input", "Fork record is invalid");
      }
      if (record.document) {
        validateJson(record.document);
        if (
          Buffer.byteLength(canonicalJson(record.document), "utf8") > 524_288
        ) {
          throw new WorkspaceForkError(
            "invalid_input",
            "Fork record is too large",
          );
        }
      }
      validatePortableImportRecord(input.workspaceId, record);
    }
    await withSystemTx(this.pool, async (tx) => {
      const authority = await lockImportAuthority(tx, {
        ...input,
        allowedStates: ["requested"],
        workosEnabled: this.workosEnabled,
      });
      if (!authority.include_chats) {
        throw new WorkspaceForkError(
          "invalid_input",
          "This fork was created without chat history",
        );
      }
      for (const record of input.records) {
        const inserted = await tx.query(
          `INSERT INTO workspace_fork_import_records (
             fork_intent_id, ordinal, org_id, target_workspace_id,
             entity_kind, entity_id, operation, schema_version, document,
             occurred_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           ON CONFLICT DO NOTHING`,
          [
            input.forkIntentId,
            record.ordinal,
            input.organizationId,
            input.workspaceId,
            record.entityKind,
            record.entityId,
            record.operation,
            record.schemaVersion,
            record.document === null ? null : canonicalJson(record.document),
            new Date(record.occurredAt),
          ],
        );
        if ((inserted.rowCount ?? 0) === 0) {
          const prior = await tx.query<{
            entity_kind: string;
            entity_id: string;
            operation: string;
            schema_version: number;
            document: unknown;
            occurred_at: Date;
          }>(
            `SELECT entity_kind, entity_id, operation, schema_version,
                    document, occurred_at
             FROM workspace_fork_import_records
             WHERE fork_intent_id = $1 AND ordinal = $2`,
            [input.forkIntentId, record.ordinal],
          );
          const row = prior.rows[0];
          if (
            !row ||
            row.entity_kind !== record.entityKind ||
            row.entity_id !== record.entityId ||
            row.operation !== record.operation ||
            row.schema_version !== record.schemaVersion ||
            canonicalJson(row.document) !== canonicalJson(record.document) ||
            row.occurred_at.toISOString() !==
              new Date(record.occurredAt).toISOString()
          ) {
            throw new WorkspaceForkError(
              "import_conflict",
              "Fork record ordinal was already staged differently",
            );
          }
        }
      }
      const aggregate = await tx.query<{
        record_count: number;
        record_bytes: string | number;
        total_bytes: string | number;
      }>(
        `SELECT count(*)::integer AS record_count,
                coalesce(sum(octet_length(document::text)), 0)::bigint AS total_bytes
         FROM workspace_fork_import_records WHERE fork_intent_id = $1`,
        [input.forkIntentId],
      );
      if (
        aggregate.rows[0]!.record_count > this.limits.maxImportRecords ||
        Number(aggregate.rows[0]!.total_bytes) >
          this.limits.maxImportRecordBytes
      ) {
        throw new WorkspaceForkError(
          "invalid_input",
          "Fork records exceed their aggregate limits",
        );
      }
    });
    return { accepted: input.records.length };
  }

  async finalizeLocalImport(input: {
    forkIntentId: string;
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    idempotencyKey: string;
  }): Promise<{ checkpointId: string; replayed: boolean }> {
    if (!SAFE_KEY.test(input.idempotencyKey)) {
      throw new WorkspaceForkError(
        "invalid_input",
        "Fork idempotency key is invalid",
      );
    }
    const claimed = await withSystemTx(this.pool, async (tx) => {
      const fork = await lockImportAuthority(tx, {
        ...input,
        allowedStates: ["requested", "importing", "succeeded"],
        workosEnabled: this.workosEnabled,
      });
      if (fork.state === "succeeded") {
        const checkpoint = await tx.query<{
          recovery_checkpoint_id: string | null;
        }>(
          `SELECT recovery_checkpoint_id FROM cloud_workspace_generations
           WHERE workspace_id = $1 AND generation = 1 AND org_id = $2`,
          [input.workspaceId, input.organizationId],
        );
        const checkpointId = checkpoint.rows[0]?.recovery_checkpoint_id;
        if (!checkpointId) {
          throw new WorkspaceForkError(
            "not_ready",
            "Fork import result is incomplete",
          );
        }
        return {
          rejected: false as const,
          replayed: true as const,
          checkpointId,
        };
      }
      if (fork.state === "importing") {
        const reclaim = await tx.query(
          `UPDATE workspace_fork_intents
           SET lease_owner = $2,
               lease_expires_at = now() + interval '5 minutes',
               attempt_count = attempt_count + 1, updated_at = now()
           WHERE id = $1 AND state = 'importing' AND lease_expires_at <= now()`,
          [input.forkIntentId, input.idempotencyKey],
        );
        if ((reclaim.rowCount ?? 0) !== 1) {
          throw new WorkspaceForkError(
            "not_ready",
            "Fork import is already finalizing",
          );
        }
      } else {
        await tx.query(
          `UPDATE workspace_fork_intents
           SET state = 'importing', lease_owner = $2,
               lease_expires_at = now() + interval '5 minutes',
               attempt_count = attempt_count + 1, updated_at = now()
           WHERE id = $1 AND state = 'requested'`,
          [input.forkIntentId, input.idempotencyKey],
        );
      }
      const summary = await tx.query<{
        entry_count: number;
        file_count: number;
        total_bytes: string | number;
        record_count: number;
        record_bytes: string | number;
        minimum_ordinal: string | number | null;
        maximum_ordinal: string | number | null;
        orphan_count: number;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM workspace_fork_import_entries
            WHERE fork_intent_id = $1) AS entry_count,
           (SELECT count(*)::integer FROM workspace_fork_import_entries
            WHERE fork_intent_id = $1 AND operation = 'upsert') AS file_count,
           (SELECT coalesce(sum(size_bytes), 0)::bigint
            FROM workspace_fork_import_entries
            WHERE fork_intent_id = $1) AS total_bytes,
           (SELECT count(*)::integer FROM workspace_fork_import_records
            WHERE fork_intent_id = $1) AS record_count,
           (SELECT coalesce(sum(octet_length(document::text)), 0)::bigint
            FROM workspace_fork_import_records
            WHERE fork_intent_id = $1) AS record_bytes,
           (SELECT min(ordinal) FROM workspace_fork_import_records
            WHERE fork_intent_id = $1) AS minimum_ordinal,
           (SELECT max(ordinal) FROM workspace_fork_import_records
            WHERE fork_intent_id = $1) AS maximum_ordinal,
           (SELECT count(*)::integer
              FROM workspace_fork_import_records child
             WHERE child.fork_intent_id = $1
               AND child.entity_kind IN ('message', 'turn')
               AND NOT EXISTS (
                 SELECT 1 FROM workspace_fork_import_records chat
                  WHERE chat.fork_intent_id = child.fork_intent_id
                    AND chat.entity_kind = 'chat'
                    AND chat.entity_id = CASE
                      WHEN child.entity_kind = 'message'
                        THEN child.document->>'chatId'
                      ELSE child.document->'row'->>'chat_id'
                    END
               )) AS orphan_count`,
        [input.forkIntentId],
      );
      const row = summary.rows[0]!;
      if (
        row.entry_count > this.limits.maxImportEntries ||
        Number(row.total_bytes) > this.limits.maxImportBytes ||
        row.record_count > this.limits.maxImportRecords ||
        Number(row.record_bytes) > this.limits.maxImportRecordBytes ||
        (!fork.include_chats && row.record_count !== 0) ||
        row.orphan_count !== 0 ||
        (row.record_count > 0 &&
          (Number(row.minimum_ordinal) !== 0 ||
            Number(row.maximum_ordinal) !== row.record_count - 1))
      ) {
        throw new WorkspaceForkError(
          "invalid_input",
          "Fork import is incomplete or exceeds its limits",
        );
      }
      if (!fork.source_git_base_commit || !fork.source_snapshot_sha256) {
        throw new WorkspaceForkError(
          "invalid_input",
          "Fork import is missing its exact source snapshot",
        );
      }
      const computedSnapshot = await localImportSnapshotSha256(tx, {
        forkIntentId: input.forkIntentId,
        gitBaseCommit: fork.source_git_base_commit,
        gitHeadRef: fork.source_git_head_ref,
      });
      if (!same(computedSnapshot, fork.source_snapshot_sha256)) {
        await releaseForkImportStaging(tx, {
          forkIntentId: input.forkIntentId,
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
        });
        await tx.query(
          `UPDATE workspace_fork_intents
           SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
               error_code = 'fork_snapshot_mismatch', completed_at = now(),
               updated_at = now()
           WHERE id = $1 AND state = 'importing'`,
          [input.forkIntentId],
        );
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
               error_code = 'fork_snapshot_mismatch',
               error_message = 'Local copy snapshot integrity verification failed',
               completed_at = now(), updated_at = now()
           WHERE workspace_id = $1 AND org_id = $2 AND operation = 'create'
             AND state IN ('queued', 'observing', 'dispatching')`,
          [input.workspaceId, input.organizationId],
        );
        await tx.query(
          `UPDATE cloud_workspaces
           SET status = 'failed', last_error_code = 'fork_snapshot_mismatch',
               last_error_message = 'Local copy snapshot integrity verification failed',
               version = version + 1, updated_at = now()
           WHERE id = $1 AND org_id = $2
             AND status IN ('requested', 'provisioning')`,
          [input.workspaceId, input.organizationId],
        );
        await audit(
          tx,
          input.organizationId,
          input.accountUserId,
          "cloud_workspace.fork_import_rejected",
          {
            forkIntentId: input.forkIntentId,
            targetCloudWorkspaceId: input.workspaceId,
            reason: "fork_snapshot_mismatch",
          },
        );
        return { rejected: true as const };
      }
      return {
        rejected: false as const,
        replayed: false as const,
        fork,
        entryCount: row.entry_count,
        fileCount: row.file_count,
        totalBytes: Number(row.total_bytes),
        recordCount: row.record_count,
      };
    });
    if (claimed.rejected) {
      throw new WorkspaceForkError(
        "import_conflict",
        "Fork import does not match its exact source snapshot",
      );
    }
    if (claimed.replayed) {
      return { checkpointId: claimed.checkpointId, replayed: true };
    }

    // This blob is later served to bootstrap and cloud-to-local export
    // clients. It must describe every durable entry, not merely summarize the
    // import: replica-local DatabaseCloudReplicaState.manifestSha256 uses a
    // different canonicalization and is deliberately never compared here.
    const checkpointManifest = await withSystemTx(this.pool, async (tx) => {
      const lease = await tx.query<{ lease_owner: string | null }>(
        `SELECT lease_owner FROM workspace_fork_intents
         WHERE id = $1 AND org_id = $2 AND state = 'importing'`,
        [input.forkIntentId, input.organizationId],
      );
      if (lease.rows[0]?.lease_owner !== input.idempotencyKey) {
        throw new WorkspaceForkError("not_ready", "Fork import lease changed");
      }
      const entries = await tx.query<{
        normalized_path: string;
        operation: "upsert" | "delete";
        entry_type: "file" | "symlink" | null;
        mode: number | null;
        content_sha256: Buffer | null;
        size_bytes: string | number | null;
      }>(
        `SELECT normalized_path, operation, entry_type, mode, content_sha256,
                size_bytes
         FROM workspace_fork_import_entries
         WHERE fork_intent_id = $1
         ORDER BY normalized_path COLLATE "C"`,
        [input.forkIntentId],
      );
      const upserts = entries.rows.filter(
        (entry) => entry.operation === "upsert",
      );
      if (
        upserts.some(
          (entry) =>
            !["file", "symlink"].includes(entry.entry_type ?? "") ||
            ![33188, 33261, 40960].includes(entry.mode ?? 0) ||
            (entry.entry_type === "symlink") !== (entry.mode === 40960) ||
            !entry.content_sha256 ||
            entry.size_bytes === null ||
            !Number.isSafeInteger(Number(entry.size_bytes)) ||
            Number(entry.size_bytes) < 0,
        )
      ) {
        throw new WorkspaceForkError(
          "import_conflict",
          "Fork import has an invalid checkpoint entry",
        );
      }
      const totalBytes = upserts.reduce(
        (total, entry) => total + Number(entry.size_bytes),
        0,
      );
      if (
        upserts.length !== claimed.fileCount ||
        totalBytes !== claimed.totalBytes ||
        entries.rows.length !== claimed.entryCount
      ) {
        throw new WorkspaceForkError(
          "import_conflict",
          "Fork import changed while sealing its manifest",
        );
      }
      return {
        version: 1,
        audience: "zeros-cloud-workspace-checkpoint-manifest-v1",
        gitBaseCommit: claimed.fork.source_git_base_commit,
        gitHeadRef: claimed.fork.source_git_head_ref,
        entries: upserts.map((entry) => ({
          path: entry.normalized_path,
          entryType: entry.entry_type,
          mode: entry.mode,
          contentSha256: entry.content_sha256!.toString("hex"),
          sizeBytes: Number(entry.size_bytes),
        })),
        deletions: entries.rows
          .filter((entry) => entry.operation === "delete")
          .map((entry) => entry.normalized_path),
      };
    });
    let manifest: Awaited<
      ReturnType<DatabaseCloudWorkspaceBlobService["putCoordinator"]>
    >;
    try {
      manifest = await this.blobs.putCoordinator({
        organizationId: input.organizationId,
        bytes: Buffer.from(canonicalJson(checkpointManifest), "utf8"),
      });
    } catch (error) {
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE workspace_fork_intents
           SET state = 'requested', lease_owner = NULL,
               lease_expires_at = NULL, updated_at = now(),
               error_code = 'import_manifest_upload_failed'
           WHERE id = $1 AND state = 'importing' AND lease_owner = $2`,
          [input.forkIntentId, input.idempotencyKey],
        ),
      );
      throw error;
    }

    return withSystemTx(this.pool, async (tx) => {
      const fork = await lockImportAuthority(tx, {
        ...input,
        allowedStates: ["importing", "succeeded"],
        workosEnabled: this.workosEnabled,
      });
      if (fork.state === "succeeded") {
        const existing = await tx.query<{ recovery_checkpoint_id: string }>(
          `SELECT recovery_checkpoint_id FROM cloud_workspace_generations
           WHERE workspace_id = $1 AND generation = 1 AND org_id = $2`,
          [input.workspaceId, input.organizationId],
        );
        return {
          checkpointId: existing.rows[0]!.recovery_checkpoint_id,
          replayed: true,
        };
      }
      const lease = await tx.query<{ lease_owner: string | null }>(
        `SELECT lease_owner FROM workspace_fork_intents WHERE id = $1`,
        [input.forkIntentId],
      );
      if (lease.rows[0]?.lease_owner !== input.idempotencyKey) {
        throw new WorkspaceForkError("not_ready", "Fork import lease changed");
      }

      const fileSummary = await tx.query<{
        count: number;
        total: string | number;
      }>(
        `SELECT count(*)::integer AS count,
                coalesce(sum(size_bytes), 0)::bigint AS total
         FROM workspace_fork_import_entries WHERE fork_intent_id = $1`,
        [input.forkIntentId],
      );
      if (
        fileSummary.rows[0]?.count !== claimed.entryCount ||
        Number(fileSummary.rows[0]?.total) !== claimed.totalBytes
      ) {
        throw new WorkspaceForkError(
          "import_conflict",
          "Fork import changed while sealing",
        );
      }

      await tx.query(
        `INSERT INTO workspace_content_heads (workspace_id, org_id)
         VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING`,
        [input.workspaceId, input.organizationId],
      );
      await tx.query(
        `INSERT INTO workspace_record_heads (workspace_id, org_id)
         VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING`,
        [input.workspaceId, input.organizationId],
      );
      const revisionCount = Math.max(1, Math.ceil(claimed.entryCount / 10_000));
      await tx.query(
        `INSERT INTO workspace_content_revisions (
           workspace_id, org_id, revision, parent_revision, authority_epoch,
           generation, engine_instance_id, idempotency_key, request_sha256,
           git_base_commit, git_head_ref, changed_entry_count,
           source_kind, fork_intent_id
         )
         SELECT $1, $2, revision, revision - 1, 1, 1, NULL,
                'fork.' || $3::text || '.' || revision::text,
                digest($3::text || ':' || revision::text, 'sha256'),
                $6::text, $7::text,
                CASE WHEN $4 = 0 THEN 0
                     ELSE least(10000, $4 - ((revision - 1) * 10000)) END,
                'fork_import', $3::uuid
         FROM generate_series(1, $5::integer) AS revision`,
        [
          input.workspaceId,
          input.organizationId,
          input.forkIntentId,
          claimed.entryCount,
          revisionCount,
          claimed.fork.source_git_base_commit,
          claimed.fork.source_git_head_ref,
        ],
      );
      await tx.query(
        `WITH ordered AS (
           SELECT entry.*,
                  row_number() OVER (
                    ORDER BY normalized_path COLLATE "C"
                  ) AS ordinal
           FROM workspace_fork_import_entries entry
           WHERE fork_intent_id = $1
         )
         INSERT INTO workspace_file_events (
           workspace_id, org_id, revision, sequence, normalized_path,
           operation, entry_type, mode, blob_id, content_sha256, size_bytes
         )
         SELECT $2, $3, ((ordinal - 1) / 10000) + 1,
                ((ordinal - 1) % 10000) + 1, normalized_path,
                operation, entry_type, mode, blob_id, content_sha256, size_bytes
         FROM ordered`,
        [input.forkIntentId, input.workspaceId, input.organizationId],
      );
      await tx.query(
        `WITH ordered AS (
           SELECT entry.*,
                  row_number() OVER (
                    ORDER BY normalized_path COLLATE "C"
                  ) AS ordinal
           FROM workspace_fork_import_entries entry
           WHERE fork_intent_id = $1
         )
         INSERT INTO workspace_file_entries (
           workspace_id, org_id, normalized_path, revision, entry_type, mode,
           blob_id, content_sha256, size_bytes
         )
         SELECT $2, $3, normalized_path,
                ((ordinal - 1) / 10000) + 1,
                entry_type, mode, blob_id, content_sha256, size_bytes
         FROM ordered WHERE operation = 'upsert'`,
        [input.forkIntentId, input.workspaceId, input.organizationId],
      );
      await tx.query(
        `WITH event_refs AS (
           INSERT INTO workspace_blob_references (
             blob_id, org_id, workspace_id, reference_kind, reference_id
           )
           SELECT blob_id, org_id, workspace_id, 'file_event',
                  workspace_id::text || ':' || revision::text || ':' || sequence::text
           FROM workspace_file_events
           WHERE workspace_id = $1 AND org_id = $2
             AND revision BETWEEN 1 AND $3
             AND blob_id IS NOT NULL
           ON CONFLICT DO NOTHING RETURNING blob_id, org_id
         ), entry_refs AS (
           INSERT INTO workspace_blob_references (
             blob_id, org_id, workspace_id, reference_kind, reference_id
           )
           SELECT blob_id, org_id, workspace_id, 'file_entry',
                  workspace_id::text || ':' ||
                    encode(digest(normalized_path, 'sha256'), 'hex')
           FROM workspace_file_entries
           WHERE workspace_id = $1 AND org_id = $2
           ON CONFLICT DO NOTHING RETURNING blob_id, org_id
         ), increments AS (
           SELECT blob_id, org_id, count(*)::bigint AS amount
           FROM (SELECT * FROM event_refs UNION ALL SELECT * FROM entry_refs) refs
           GROUP BY blob_id, org_id
         )
         UPDATE workspace_blobs blob
         SET reference_count = blob.reference_count + increments.amount
         FROM increments
         WHERE blob.id = increments.blob_id AND blob.org_id = increments.org_id`,
        [input.workspaceId, input.organizationId, revisionCount],
      );

      const recordCount = (
        await tx.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM workspace_fork_import_records
           WHERE fork_intent_id = $1`,
          [input.forkIntentId],
        )
      ).rows[0]!.count;
      if (recordCount > 0) {
        const batchCount = Math.ceil(recordCount / 100);
        await tx.query(
          `INSERT INTO workspace_record_batches (
             workspace_id, org_id, engine_instance_id, authority_epoch,
             idempotency_key, request_sha256, first_revision, last_revision,
             event_count, source_kind, fork_intent_id
           )
           SELECT $1, $2, NULL, 1,
                  'fork.' || $3::text || '.record.' || batch::text,
                  digest($3::text || ':record:' || batch::text, 'sha256'),
                  ((batch - 1) * 100) + 1,
                  least(batch * 100, $4),
                  least(100, $4 - ((batch - 1) * 100)),
                  'fork_import', $3::uuid
           FROM generate_series(1, $5::integer) AS batch`,
          [
            input.workspaceId,
            input.organizationId,
            input.forkIntentId,
            recordCount,
            batchCount,
          ],
        );
        await tx.query(
          `WITH ordered AS (
             SELECT record.*,
                    row_number() OVER (ORDER BY ordinal) AS revision
             FROM workspace_fork_import_records record
             WHERE fork_intent_id = $1
           ), batches AS (
             SELECT id, first_revision, last_revision
             FROM workspace_record_batches
             WHERE workspace_id = $2 AND fork_intent_id = $1
           )
           INSERT INTO workspace_record_events (
             workspace_id, org_id, revision, batch_id, entity_kind,
             entity_id, operation, schema_version, document, actor_user_id,
             occurred_at
           )
           SELECT $2, $3, ordered.revision, batches.id, entity_kind,
                  entity_id, operation, schema_version, document, $4,
                  occurred_at
           FROM ordered JOIN batches
             ON ordered.revision BETWEEN batches.first_revision AND batches.last_revision`,
          [
            input.forkIntentId,
            input.workspaceId,
            input.organizationId,
            input.accountUserId,
          ],
        );
        await tx.query(
          `INSERT INTO workspace_record_entities (
             workspace_id, org_id, entity_kind, entity_id, revision,
             schema_version, document, tombstoned_at
           )
           SELECT DISTINCT ON (entity_kind, entity_id)
                  workspace_id, org_id, entity_kind, entity_id, revision,
                  schema_version, document,
                  CASE WHEN operation = 'tombstone' THEN occurred_at ELSE NULL END
           FROM workspace_record_events WHERE workspace_id = $1
           ORDER BY entity_kind, entity_id, revision DESC`,
          [input.workspaceId],
        );
      }

      const checkpointId = randomUUID();
      await tx.query(
        `INSERT INTO workspace_checkpoints (
           id, workspace_id, org_id, idempotency_key, request_sha256,
           content_revision, record_revision, authority_epoch, generation,
           reason, manifest_blob_id, inclusion_policy, file_count, total_bytes,
           git_base_commit, git_head_ref, state, integrity_sha256, created_by,
           durable_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 1, 1, 'recovery', $8,
           $9::jsonb, $10, $11, $12, $13, 'durable', $14, $15, now()
         )`,
        [
          checkpointId,
          input.workspaceId,
          input.organizationId,
          `fork.${input.forkIntentId}.checkpoint`,
          digest(checkpointManifest),
          revisionCount,
          recordCount,
          manifest.id,
          canonicalJson({
            source: "local_fork",
            ignored: "excluded",
            secrets: "excluded",
          }),
          claimed.fileCount,
          claimed.totalBytes,
          claimed.fork.source_git_base_commit,
          claimed.fork.source_git_head_ref,
          Buffer.from(manifest.plaintextSha256, "hex"),
          input.accountUserId,
        ],
      );
      await tx.query(
        `INSERT INTO workspace_checkpoint_entries (
           checkpoint_id, workspace_id, org_id, normalized_path, operation,
           entry_type, mode, blob_id, content_sha256, size_bytes
         )
         SELECT $1, target_workspace_id, org_id, normalized_path, operation,
                entry_type, mode, blob_id, content_sha256, size_bytes
         FROM workspace_fork_import_entries
         WHERE fork_intent_id = $2`,
        [checkpointId, input.forkIntentId],
      );
      await tx.query(
        `WITH inserted AS (
           INSERT INTO workspace_blob_references (
             blob_id, org_id, workspace_id, reference_kind, reference_id
           )
           SELECT DISTINCT blob_id, org_id, workspace_id,
                  'checkpoint_file', $1::text
           FROM workspace_checkpoint_entries
           WHERE checkpoint_id = $1::uuid AND blob_id IS NOT NULL
           ON CONFLICT DO NOTHING RETURNING blob_id, org_id
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
      await addReferences(tx, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        kind: "checkpoint_manifest",
        referenceId: checkpointId,
        blobIds: [manifest.id],
      });
      await tx.query(
        `UPDATE workspace_content_heads
         SET current_revision = $2, durable_revision = $2,
             current_checkpoint_id = $3, last_durable_at = now(),
             updated_at = now() WHERE workspace_id = $1`,
        [input.workspaceId, revisionCount, checkpointId],
      );
      await tx.query(
        `UPDATE workspace_record_heads
         SET current_revision = $2, last_durable_at = now(), updated_at = now()
         WHERE workspace_id = $1`,
        [input.workspaceId, recordCount],
      );
      await tx.query(
        `UPDATE cloud_workspace_generations
         SET recovery_checkpoint_id = $3
         WHERE workspace_id = $1 AND org_id = $2 AND generation = 1`,
        [input.workspaceId, input.organizationId, checkpointId],
      );
      await releaseForkImportStaging(tx, {
        forkIntentId: input.forkIntentId,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
      });
      await tx.query(
        `UPDATE workspace_fork_intents
         SET state = 'succeeded', result_blob_id = $3,
             lease_owner = NULL, lease_expires_at = NULL,
             error_code = NULL, completed_at = now(), updated_at = now()
         WHERE id = $1 AND org_id = $2 AND state = 'importing'`,
        [input.forkIntentId, input.organizationId, manifest.id],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_outbox (
           org_id, workspace_id, event_type, aggregate_key,
           aggregate_revision, idempotency_key, payload
         ) VALUES ($1, $2, 'workspace.fork_imported', $3, 1, $4, $5::jsonb)`,
        [
          input.organizationId,
          input.workspaceId,
          `workspace:${input.workspaceId}`,
          `fork:${input.forkIntentId}:imported`,
          canonicalJson({
            forkIntentId: input.forkIntentId,
            sourceLocalWorkspaceId: fork.source_local_workspace_id,
            targetCloudWorkspaceId: input.workspaceId,
            checkpointId,
          }),
        ],
      );
      await audit(
        tx,
        input.organizationId,
        input.accountUserId,
        "cloud_workspace.fork_imported",
        {
          forkIntentId: input.forkIntentId,
          sourceLocalWorkspaceId: fork.source_local_workspace_id,
          targetCloudWorkspaceId: input.workspaceId,
          checkpointId,
          entryCount: claimed.entryCount,
          fileCount: claimed.fileCount,
          recordCount,
        },
      );
      return { checkpointId, replayed: false };
    });
  }

  async requestCloudToLocal(input: {
    organizationId: string;
    workspaceId: string;
    targetLocalWorkspaceId: string;
    accountUserId: string;
    idempotencyKey: string;
    includeChats: boolean;
  }): Promise<{
    forkIntentId: string;
    checkpointRequestId: string;
    replayed: boolean;
  }> {
    if (
      !UUID_PATTERN.test(input.targetLocalWorkspaceId) ||
      !SAFE_KEY.test(input.idempotencyKey)
    ) {
      throw new WorkspaceForkError(
        "invalid_input",
        "Cloud copy request is invalid",
      );
    }
    if (input.targetLocalWorkspaceId === input.workspaceId) {
      throw new WorkspaceForkError(
        "invalid_input",
        "A local copy must have a new workspace identity",
      );
    }
    const requestSha256 = digest({
      operation: "cloud_to_local",
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      targetLocalWorkspaceId: input.targetLocalWorkspaceId,
      includeChats: input.includeChats,
    });
    return withSystemTx(this.pool, async (tx) => {
      // Serialize the user-scoped key even when a malformed retry changes its
      // workspace id. The workspace authorization is intentionally checked
      // before returning an existing result: idempotency is not an access
      // capability after Team membership or ownership is revoked.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 31))`, [
        `cloud-to-local-fork:${input.organizationId}:${input.accountUserId}:${input.idempotencyKey}`,
      ]);
      const workspace = await tx.query<{
        team_id: string;
        owner_user_id: string;
        current_generation: number;
        status: string;
        desired_state: string;
      }>(
        `SELECT team_id, owner_user_id, current_generation, status, desired_state
         FROM cloud_workspaces
         WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [input.workspaceId, input.organizationId],
      );
      const row = workspace.rows[0];
      if (!row)
        throw new WorkspaceForkError("not_found", "Cloud workspace not found");
      await authorizeCloudWorkspaceDataAccess(tx, {
        organizationId: input.organizationId,
        teamId: row.team_id,
        actorUserId: input.accountUserId,
        ownerUserId: row.owner_user_id,
        requireWorkspaceOwner: true,
      });
      const existing = await tx.query<{
        id: string;
        request_sha256: Buffer;
      }>(
        `SELECT id, request_sha256 FROM workspace_fork_intents
         WHERE org_id = $1 AND requested_by = $2 AND idempotency_key = $3
         FOR UPDATE`,
        [input.organizationId, input.accountUserId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (!same(existing.rows[0].request_sha256, requestSha256)) {
          throw new WorkspaceForkError(
            "idempotency_conflict",
            "Fork idempotency key was reused",
          );
        }
        const checkpoint = await tx.query<{ id: string }>(
          `SELECT id FROM workspace_checkpoint_requests WHERE fork_intent_id = $1`,
          [existing.rows[0].id],
        );
        if (!checkpoint.rows[0]) {
          throw new WorkspaceForkError(
            "not_ready",
            "Fork checkpoint request is incomplete",
          );
        }
        return {
          forkIntentId: existing.rows[0].id,
          checkpointRequestId: checkpoint.rows[0].id,
          replayed: true,
        };
      }
      const running =
        row.desired_state === "running" &&
        ["ready", "busy"].includes(row.status);
      if (!running && !["stopped", "archived", "failed"].includes(row.status)) {
        throw new WorkspaceForkError(
          "not_ready",
          "Cloud workspace must be stable before making a local copy",
        );
      }
      const heads = await tx.query<{
        content_revision: string | number;
        checkpoint_id: string | null;
        checkpoint_revision: string | number | null;
      }>(
        `SELECT coalesce(content.current_revision, 0) AS content_revision,
                content.current_checkpoint_id AS checkpoint_id,
                checkpoint.content_revision AS checkpoint_revision
         FROM cloud_workspaces workspace
         LEFT JOIN workspace_content_heads content
           ON content.workspace_id = workspace.id
          AND content.org_id = workspace.org_id
         LEFT JOIN workspace_checkpoints checkpoint
           ON checkpoint.id = content.current_checkpoint_id
          AND checkpoint.workspace_id = workspace.id
          AND checkpoint.org_id = workspace.org_id
          AND checkpoint.state = 'durable'
         WHERE workspace.id = $1`,
        [input.workspaceId],
      );
      const head = heads.rows[0];
      if (
        !running &&
        (!head?.checkpoint_id || head.checkpoint_revision === null)
      ) {
        throw new WorkspaceForkError(
          "not_ready",
          "No durable checkpoint is available for this cloud workspace",
        );
      }
      const forkIntentId = randomUUID();
      await tx.query(
        `INSERT INTO workspace_fork_intents (
           id, org_id, requested_by, operation, source_cloud_workspace_id,
           target_local_workspace_id, source_revision, include_chats,
           idempotency_key, request_sha256
         ) VALUES ($1, $2, $3, 'cloud_to_local', $4, $5, $6, $7, $8, $9)`,
        [
          forkIntentId,
          input.organizationId,
          input.accountUserId,
          input.workspaceId,
          input.targetLocalWorkspaceId,
          running
            ? Number(head?.content_revision ?? 0)
            : Number(head!.checkpoint_revision),
          input.includeChats,
          input.idempotencyKey,
          requestSha256,
        ],
      );
      const checkpoint = await enqueueWorkspaceCheckpointRequest(tx, {
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        generation: row.current_generation,
        requestedBy: input.accountUserId,
        reason: "before_fork",
        idempotencyKey: `fork.${forkIntentId}`,
      });
      if (!running) {
        const bound = await tx.query(
          `UPDATE workspace_checkpoint_requests
           SET state = 'succeeded', checkpoint_id = $2,
               completed_at = now(), error_code = NULL
           WHERE id = $1 AND workspace_id = $3 AND org_id = $4
             AND state = 'queued'`,
          [
            checkpoint.id,
            head!.checkpoint_id,
            input.workspaceId,
            input.organizationId,
          ],
        );
        if ((bound.rowCount ?? 0) !== 1) {
          throw new WorkspaceForkError(
            "not_ready",
            "Durable checkpoint binding changed during export",
          );
        }
      }
      await tx.query(
        `UPDATE workspace_checkpoint_requests SET fork_intent_id = $2
         WHERE id = $1`,
        [checkpoint.id, forkIntentId],
      );
      await audit(
        tx,
        input.organizationId,
        input.accountUserId,
        "cloud_workspace.local_copy_requested",
        {
          workspaceId: input.workspaceId,
          targetLocalWorkspaceId: input.targetLocalWorkspaceId,
          forkIntentId,
          checkpointRequestId: checkpoint.id,
          checkpointSource: running ? "fresh" : "last_durable",
        },
      );
      return {
        forkIntentId,
        checkpointRequestId: checkpoint.id,
        replayed: false,
      };
    });
  }

  async issueExportGrant(input: {
    forkIntentId: string;
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    proof: CloudWorkspaceDeviceProof;
  }): Promise<{
    grantToken: string;
    deviceId: string;
    deviceKeyVersion: number;
    expiresAt: string;
  }> {
    if (
      !UUID_PATTERN.test(input.forkIntentId) ||
      !UUID_PATTERN.test(input.organizationId) ||
      !UUID_PATTERN.test(input.workspaceId) ||
      !UUID_PATTERN.test(input.accountUserId)
    ) {
      throw new WorkspaceForkError(
        "invalid_input",
        "Export grant input is invalid",
      );
    }
    const payload = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      forkIntentId: input.forkIntentId,
    };
    const secret = randomBytes(32);
    const grantToken = `zwe_${secret.toString("base64url")}`;
    const tokenSha256 = createHash("sha256")
      .update(grantToken, "utf8")
      .digest();
    secret.fill(0);
    try {
      return await withSystemTx(this.pool, async (tx) => {
        const authority = (
          await tx.query<{
            export_id: string;
            export_expires_at: Date | string;
            team_id: string;
            owner_user_id: string;
          }>(
            `SELECT export.id AS export_id,
                    export.expires_at AS export_expires_at,
                    workspace.team_id, workspace.owner_user_id
             FROM workspace_fork_intents fork
             JOIN workspace_exports export
               ON export.id = fork.export_id AND export.org_id = fork.org_id
             JOIN cloud_workspaces workspace
               ON workspace.id = fork.source_cloud_workspace_id
              AND workspace.org_id = fork.org_id
             WHERE fork.id = $1 AND fork.org_id = $2
               AND fork.source_cloud_workspace_id = $3
               AND fork.requested_by = $4
               AND fork.operation = 'cloud_to_local'
               AND fork.state = 'succeeded'
               AND fork.source_checkpoint_id IS NOT NULL
               AND export.state = 'available' AND export.expires_at > now()
               AND export.checkpoint_id = fork.source_checkpoint_id
               AND workspace.deleted_at IS NULL
             FOR UPDATE OF fork, export, workspace`,
            [
              input.forkIntentId,
              input.organizationId,
              input.workspaceId,
              input.accountUserId,
            ],
          )
        ).rows[0];
        if (!authority) {
          throw new WorkspaceForkError(
            "export_unavailable",
            "Workspace export is not ready",
          );
        }
        await authorizeCloudWorkspaceDataAccess(tx, {
          organizationId: input.organizationId,
          teamId: authority.team_id,
          actorUserId: input.accountUserId,
          ownerUserId: authority.owner_user_id,
          requireWorkspaceOwner: true,
        });
        let device;
        try {
          device = await consumeCloudWorkspaceDeviceProof(tx, {
            accountUserId: input.accountUserId,
            action: "fork.export.grant",
            payload,
            proof: input.proof,
          });
        } catch (error) {
          if (
            error instanceof WorkspaceReplicaError &&
            (error.code === "device_proof_rejected" ||
              error.code === "device_proof_replayed")
          ) {
            throw new WorkspaceForkError(error.code, error.message);
          }
          throw error;
        }
        await tx.query(
          `UPDATE workspace_export_grants
           SET revoked_at = now()
           WHERE export_id = $1 AND user_id = $2 AND device_id = $3
             AND revoked_at IS NULL`,
          [authority.export_id, input.accountUserId, device.id],
        );
        const inserted = await tx.query<{ expires_at: Date }>(
          `INSERT INTO workspace_export_grants (
             export_id, fork_intent_id, workspace_id, org_id, user_id,
             device_id, device_key_version, token_sha256, expires_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             least($9::timestamptz, now() + interval '5 minutes')
           ) RETURNING expires_at`,
          [
            authority.export_id,
            input.forkIntentId,
            input.workspaceId,
            input.organizationId,
            input.accountUserId,
            device.id,
            Number(device.key_version),
            tokenSha256,
            authority.export_expires_at,
          ],
        );
        await audit(
          tx,
          input.organizationId,
          input.accountUserId,
          "cloud_workspace.export_grant_issued",
          {
            workspaceId: input.workspaceId,
            forkIntentId: input.forkIntentId,
            exportId: authority.export_id,
            deviceId: device.id,
            deviceKeyVersion: Number(device.key_version),
          },
        );
        return {
          grantToken,
          deviceId: device.id,
          deviceKeyVersion: Number(device.key_version),
          expiresAt: inserted.rows[0]!.expires_at.toISOString(),
        };
      });
    } finally {
      tokenSha256.fill(0);
    }
  }

  private async authorizeExportGrant(
    tx: Tx,
    input: {
      forkIntentId: string;
      organizationId: string;
      workspaceId: string;
      accountUserId: string;
      grantToken: string;
      action: string;
      payload: unknown;
      proof: CloudWorkspaceDeviceProof;
    },
  ): Promise<ExportGrantAuthority> {
    if (
      !/^zwe_[A-Za-z0-9_-]{43}$/.test(input.grantToken) ||
      !UUID_PATTERN.test(input.forkIntentId) ||
      !UUID_PATTERN.test(input.organizationId) ||
      !UUID_PATTERN.test(input.workspaceId) ||
      !UUID_PATTERN.test(input.accountUserId)
    ) {
      throw new WorkspaceForkError("grant_rejected", "Export grant is invalid");
    }
    const tokenSha256 = createHash("sha256")
      .update(input.grantToken, "utf8")
      .digest();
    try {
      const authority = (
        await tx.query<ExportGrantAuthority>(
          `SELECT export_grant.id AS grant_id, export_grant.device_id,
                  export_grant.device_key_version, export.id AS export_id,
                  export.export_blob_id AS export_manifest_blob_id,
                  export_blob.plaintext_sha256 AS export_manifest_sha256,
                  fork.source_cloud_workspace_id, fork.source_checkpoint_id,
                  fork.target_local_workspace_id, fork.include_chats,
                  workspace.team_id, workspace.owner_user_id,
                  workspace.repository_forge, workspace.repository_owner,
                  workspace.repository_name, workspace.repository_revision,
                  checkpoint.content_revision, checkpoint.record_revision,
                  checkpoint.file_count, checkpoint.total_bytes,
                  checkpoint.git_base_commit, checkpoint.git_head_ref,
                  checkpoint.manifest_blob_id, checkpoint.integrity_sha256
           FROM workspace_export_grants export_grant
           JOIN workspace_exports export
             ON export.id = export_grant.export_id
            AND export.org_id = export_grant.org_id
           JOIN workspace_fork_intents fork
             ON fork.id = export_grant.fork_intent_id
            AND fork.org_id = export_grant.org_id
            AND fork.export_id = export.id
           JOIN workspace_blobs export_blob
             ON export_blob.id = export.export_blob_id
            AND export_blob.org_id = export.org_id
            AND export_blob.state = 'available'
           JOIN cloud_workspaces workspace
             ON workspace.id = export_grant.workspace_id
            AND workspace.org_id = export_grant.org_id
           JOIN workspace_checkpoints checkpoint
             ON checkpoint.id = fork.source_checkpoint_id
            AND checkpoint.workspace_id = export_grant.workspace_id
            AND checkpoint.org_id = export_grant.org_id
           WHERE export_grant.fork_intent_id = $1
             AND export_grant.org_id = $2
             AND export_grant.workspace_id = $3
             AND export_grant.user_id = $4
             AND export_grant.token_sha256 = $5
             AND export_grant.revoked_at IS NULL
             AND export_grant.expires_at > now()
             AND fork.operation = 'cloud_to_local' AND fork.state = 'succeeded'
             AND fork.requested_by = export_grant.user_id
             AND fork.source_cloud_workspace_id = export_grant.workspace_id
             AND export.state = 'available' AND export.expires_at > now()
             AND export.checkpoint_id = fork.source_checkpoint_id
             AND checkpoint.state = 'durable'
             AND workspace.deleted_at IS NULL
           FOR UPDATE OF export_grant, workspace`,
          [
            input.forkIntentId,
            input.organizationId,
            input.workspaceId,
            input.accountUserId,
            tokenSha256,
          ],
        )
      ).rows[0];
      if (!authority || authority.device_id !== input.proof.deviceId) {
        throw new WorkspaceForkError(
          "grant_rejected",
          "Export grant is invalid",
        );
      }
      await authorizeCloudWorkspaceDataAccess(tx, {
        organizationId: input.organizationId,
        teamId: authority.team_id,
        actorUserId: input.accountUserId,
        ownerUserId: authority.owner_user_id,
        requireWorkspaceOwner: true,
      });
      let device;
      try {
        device = await consumeCloudWorkspaceDeviceProof(tx, {
          accountUserId: input.accountUserId,
          action: input.action,
          payload: input.payload,
          proof: input.proof,
        });
      } catch (error) {
        if (
          error instanceof WorkspaceReplicaError &&
          (error.code === "device_proof_rejected" ||
            error.code === "device_proof_replayed")
        ) {
          throw new WorkspaceForkError(error.code, error.message);
        }
        throw error;
      }
      if (
        device.id !== authority.device_id ||
        Number(device.key_version) !== Number(authority.device_key_version)
      ) {
        throw new WorkspaceForkError("grant_rejected", "Export grant is stale");
      }
      await tx.query(
        `UPDATE workspace_export_grants SET last_used_at = now() WHERE id = $1`,
        [authority.grant_id],
      );
      return authority;
    } finally {
      tokenSha256.fill(0);
    }
  }

  async readExportManifest(input: {
    forkIntentId: string;
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    grantToken: string;
    afterPath: string | null;
    limit?: number;
    proof: CloudWorkspaceDeviceProof;
  }) {
    const limit = input.limit ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new WorkspaceForkError(
        "invalid_input",
        "Export page size is invalid",
      );
    }
    const afterPath =
      input.afterPath === null ? null : normalizedRelativePath(input.afterPath);
    const payload = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      forkIntentId: input.forkIntentId,
      afterPath,
      limit,
    };
    return withSystemTx(this.pool, async (tx) => {
      const authority = await this.authorizeExportGrant(tx, {
        ...input,
        action: "fork.export.manifest.read",
        payload,
      });
      const entries = await tx.query<{
        normalized_path: string;
        operation: "upsert" | "delete";
        entry_type: "file" | "symlink" | null;
        mode: number | null;
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
         ORDER BY normalized_path COLLATE "C" LIMIT $3`,
        [authority.source_checkpoint_id, afterPath, limit + 1],
      );
      const page = entries.rows.slice(0, limit);
      return {
        sourceCloudWorkspaceId: authority.source_cloud_workspace_id,
        targetLocalWorkspaceId: authority.target_local_workspace_id,
        checkpointId: authority.source_checkpoint_id,
        exportManifestBlobId: authority.export_manifest_blob_id,
        exportManifestSha256: authority.export_manifest_sha256.toString("hex"),
        manifestBlobId: authority.manifest_blob_id,
        integritySha256: authority.integrity_sha256.toString("hex"),
        contentRevision: Number(authority.content_revision),
        recordRevision: Number(authority.record_revision),
        includeChats: authority.include_chats,
        fileCount: authority.file_count,
        totalBytes: Number(authority.total_bytes),
        gitBaseCommit: authority.git_base_commit,
        gitHeadRef: authority.git_head_ref,
        repository: {
          forge: authority.repository_forge,
          owner: authority.repository_owner,
          name: authority.repository_name,
          revision: authority.repository_revision,
        },
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
        nextAfterPath:
          entries.rows.length > limit
            ? page[page.length - 1]!.normalized_path
            : null,
      };
    });
  }

  async readExportRecords(input: {
    forkIntentId: string;
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    grantToken: string;
    afterRevision: number;
    limit?: number;
    proof: CloudWorkspaceDeviceProof;
  }) {
    // A record document may be 512 KiB. Twenty keeps the serialized response
    // below the desktop's bounded 16 MiB JSON envelope with useful headroom.
    const limit = input.limit ?? 20;
    if (
      !Number.isSafeInteger(input.afterRevision) ||
      input.afterRevision < 0 ||
      limit < 1 ||
      limit > 20
    ) {
      throw new WorkspaceForkError(
        "invalid_input",
        "Export record cursor is invalid",
      );
    }
    const payload = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      forkIntentId: input.forkIntentId,
      afterRevision: input.afterRevision,
      limit,
    };
    return withSystemTx(this.pool, async (tx) => {
      const authority = await this.authorizeExportGrant(tx, {
        ...input,
        action: "fork.export.records.read",
        payload,
      });
      if (!authority.include_chats) {
        throw new WorkspaceForkError(
          "export_unavailable",
          "Workspace records are unavailable",
        );
      }
      const highWatermark = Number(authority.record_revision);
      const events = await tx.query<{
        revision: string | number;
        entity_kind: string;
        entity_id: string;
        operation: string;
        schema_version: number;
        document: Record<string, unknown> | null;
        occurred_at: Date;
      }>(
        `SELECT revision, entity_kind, entity_id, operation, schema_version,
                document, occurred_at
         FROM workspace_record_events
         WHERE workspace_id = $1 AND org_id = $2
           AND revision > $3 AND revision <= $4
         ORDER BY revision LIMIT $5`,
        [
          authority.source_cloud_workspace_id,
          input.organizationId,
          input.afterRevision,
          highWatermark,
          limit,
        ],
      );
      return {
        recordRevision: highWatermark,
        events: events.rows.map((event) => ({
          revision: Number(event.revision),
          entityKind: event.entity_kind,
          entityId: event.entity_id,
          operation: event.operation,
          schemaVersion: event.schema_version,
          document: event.document,
          occurredAt: event.occurred_at.toISOString(),
        })),
        hasMore:
          events.rows.length > 0 &&
          Number(events.rows[events.rows.length - 1]!.revision) < highWatermark,
      };
    });
  }

  async readExportBlob(input: {
    forkIntentId: string;
    organizationId: string;
    workspaceId: string;
    accountUserId: string;
    grantToken: string;
    blobId: string;
    proof: CloudWorkspaceDeviceProof;
  }): Promise<Buffer> {
    if (!UUID_PATTERN.test(input.blobId)) {
      throw new WorkspaceForkError("invalid_input", "Export blob is invalid");
    }
    const payload = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      forkIntentId: input.forkIntentId,
      blobId: input.blobId,
    };
    const authorized = await withSystemTx(this.pool, async (tx) => {
      const authority = await this.authorizeExportGrant(tx, {
        ...input,
        action: "fork.export.blob.read",
        payload,
      });
      const result = await tx.query(
        `SELECT 1 FROM workspace_checkpoint_entries entry
         WHERE entry.checkpoint_id = $1
           AND entry.workspace_id = $2 AND entry.org_id = $3
           AND entry.operation = 'upsert' AND entry.blob_id = $4
         UNION ALL
         SELECT 1 FROM workspace_checkpoints checkpoint
         WHERE checkpoint.id = $1 AND checkpoint.workspace_id = $2
           AND checkpoint.org_id = $3 AND checkpoint.state = 'durable'
           AND checkpoint.manifest_blob_id = $4
         UNION ALL
         SELECT 1 FROM workspace_exports export
         WHERE export.id = $5 AND export.org_id = $3
           AND export.workspace_id = $2 AND export.export_blob_id = $4
         LIMIT 1`,
        [
          authority.source_checkpoint_id,
          authority.source_cloud_workspace_id,
          input.organizationId,
          input.blobId,
          authority.export_id,
        ],
      );
      return (result.rowCount ?? 0) === 1;
    });
    if (!authorized) {
      throw new WorkspaceForkError(
        "not_found",
        "Workspace export blob not found",
      );
    }
    try {
      return await this.blobs.getSystem({
        blobId: input.blobId,
        organizationId: input.organizationId,
      });
    } catch (error) {
      if (error instanceof WorkspaceBlobError) {
        throw new WorkspaceForkError(
          "export_unavailable",
          "Workspace export blob is unavailable",
        );
      }
      throw error;
    }
  }
}

async function expireWorkspaceForkIntents(tx: Tx): Promise<number> {
  const candidates = await tx.query<{
    id: string;
    org_id: string;
    requested_by: string;
    operation: "local_to_cloud" | "cloud_to_local";
    source_cloud_workspace_id: string | null;
    target_cloud_workspace_id: string | null;
  }>(
    `SELECT id, org_id, requested_by, operation,
            source_cloud_workspace_id, target_cloud_workspace_id
     FROM workspace_fork_intents
     WHERE state NOT IN ('succeeded', 'failed', 'cancelled')
       AND deadline_at <= now()
     ORDER BY deadline_at, id
     FOR UPDATE SKIP LOCKED LIMIT 100`,
  );
  for (const fork of candidates.rows) {
    if (fork.operation === "local_to_cloud" && fork.target_cloud_workspace_id) {
      await releaseForkImportStaging(tx, {
        forkIntentId: fork.id,
        organizationId: fork.org_id,
        workspaceId: fork.target_cloud_workspace_id,
      });
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
             error_code = 'fork_deadline_exceeded',
             error_message = 'Local copy upload did not complete before its deadline',
             completed_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND org_id = $2 AND operation = 'create'
           AND state IN ('queued', 'observing', 'dispatching')`,
        [fork.target_cloud_workspace_id, fork.org_id],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET status = 'failed', last_error_code = 'fork_deadline_exceeded',
             last_error_message = 'Local copy upload did not complete before its deadline',
             version = version + 1, updated_at = now()
         WHERE id = $1 AND org_id = $2
           AND status IN ('requested', 'provisioning')`,
        [fork.target_cloud_workspace_id, fork.org_id],
      );
    }
    await tx.query(
      `UPDATE workspace_export_grants
       SET revoked_at = coalesce(revoked_at, now())
       WHERE fork_intent_id = $1 AND revoked_at IS NULL`,
      [fork.id],
    );
    await tx.query(
      `UPDATE workspace_exports
       SET state = 'expired', checkpoint_id = NULL,
           lease_owner = NULL, lease_expires_at = NULL,
           completed_at = coalesce(completed_at, now())
       WHERE fork_intent_id = $1 AND state NOT IN ('expired', 'deleted')`,
      [fork.id],
    );
    await tx.query(
      `UPDATE workspace_fork_intents
       SET state = 'failed', error_code = 'fork_deadline_exceeded',
           lease_owner = NULL, lease_expires_at = NULL,
           completed_at = now(), updated_at = now()
       WHERE id = $1`,
      [fork.id],
    );
    await audit(
      tx,
      fork.org_id,
      fork.requested_by,
      "cloud_workspace.fork_expired",
      {
        forkIntentId: fork.id,
        operation: fork.operation,
        sourceCloudWorkspaceId: fork.source_cloud_workspace_id,
        targetCloudWorkspaceId: fork.target_cloud_workspace_id,
      },
    );
  }
  return candidates.rows.length;
}

export class CloudWorkspaceForkWorker {
  private readonly workerId: string;
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private stopped = false;
  private started = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly blobs: DatabaseCloudWorkspaceBlobService,
    private readonly options: {
      intervalMs?: number;
      leaseMs?: number;
      workerId?: string;
      logger?: Pick<Console, "error">;
    } = {},
  ) {
    const intervalMs = options.intervalMs ?? 2_000;
    const leaseMs = options.leaseMs ?? 60_000;
    if (
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 250 ||
      intervalMs > 300_000 ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 5_000 ||
      leaseMs > 3_600_000
    )
      throw new Error("cloud workspace fork worker timing is invalid");
    this.workerId = options.workerId ?? `cloud-fork:${randomUUID()}`;
  }

  start(): () => Promise<void> {
    if (this.started || this.stopped)
      throw new Error("fork worker lifecycle is invalid");
    this.started = true;
    const run = () => {
      if (this.stopped) return;
      const task = this.drain().catch((error) =>
        (this.options.logger ?? console).error(
          `[cloud-workspace] fork tick failed: ${error instanceof Error ? error.name : "unknown"}`,
        ),
      );
      this.active = task;
      void task.finally(() => {
        if (this.active === task) this.active = null;
        if (this.stopped) return;
        this.timer = setTimeout(run, this.options.intervalMs ?? 2_000);
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
    await this.active;
  }

  private async drain(): Promise<void> {
    for (let index = 0; index < 20 && !this.stopped; index += 1) {
      if (!(await this.runOnce())) return;
    }
  }

  async runOnce(): Promise<boolean> {
    const claimed = await withSystemTx(this.pool, async (tx) => {
      const deadlineExpired = await expireWorkspaceForkIntents(tx);
      const expired = await tx.query(
        `UPDATE workspace_fork_intents fork
         SET state = 'failed', error_code = 'checkpoint_unavailable',
             completed_at = now(), updated_at = now()
         FROM workspace_checkpoint_requests request
         WHERE request.fork_intent_id = fork.id
           AND fork.operation = 'cloud_to_local'
           AND fork.state = 'requested'
           AND request.state IN ('failed', 'expired', 'cancelled')`,
      );
      const row = (
        await tx.query<{
          id: string;
          org_id: string;
          requested_by: string;
          source_cloud_workspace_id: string;
          target_local_workspace_id: string;
          include_chats: boolean;
          checkpoint_id: string;
          content_revision: string | number;
          record_revision: string | number;
          file_count: number;
          total_bytes: string | number;
        }>(
          `WITH candidate AS (
             SELECT fork.id
             FROM workspace_fork_intents fork
             JOIN workspace_checkpoint_requests request
               ON request.fork_intent_id = fork.id AND request.state = 'succeeded'
             WHERE fork.operation = 'cloud_to_local'
               AND (
                 fork.state = 'requested'
                 OR (fork.state = 'exporting' AND fork.lease_expires_at <= now())
               )
             ORDER BY fork.created_at, fork.id
             FOR UPDATE OF fork SKIP LOCKED LIMIT 1
           )
           UPDATE workspace_fork_intents fork
           SET state = 'exporting', lease_owner = $1,
               lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
               attempt_count = attempt_count + 1, updated_at = now(),
               error_code = NULL
           FROM candidate, workspace_checkpoint_requests request,
                workspace_checkpoints checkpoint
           WHERE fork.id = candidate.id
             AND request.fork_intent_id = fork.id AND request.state = 'succeeded'
             AND checkpoint.id = request.checkpoint_id
           RETURNING fork.id, fork.org_id, fork.requested_by,
                     fork.source_cloud_workspace_id,
                     fork.target_local_workspace_id, fork.include_chats,
                     checkpoint.id AS checkpoint_id,
                     checkpoint.content_revision, checkpoint.record_revision,
                     checkpoint.file_count, checkpoint.total_bytes`,
          [this.workerId, this.options.leaseMs ?? 60_000],
        )
      ).rows[0];
      return {
        row: row ?? null,
        expired: deadlineExpired + (expired.rowCount ?? 0),
      };
    });
    if (!claimed.row) return claimed.expired > 0;
    const row = claimed.row;
    const descriptor = {
      audience: "zeros-cloud-to-local-fork-v1",
      forkIntentId: row.id,
      sourceCloudWorkspaceId: row.source_cloud_workspace_id,
      targetLocalWorkspaceId: row.target_local_workspace_id,
      checkpointId: row.checkpoint_id,
      contentRevision: Number(row.content_revision),
      recordRevision: Number(row.record_revision),
      includeChats: row.include_chats,
      fileCount: row.file_count,
      totalBytes: Number(row.total_bytes),
    };
    try {
      const manifest = await this.blobs.putCoordinator({
        organizationId: row.org_id,
        bytes: Buffer.from(canonicalJson(descriptor), "utf8"),
      });
      await withSystemTx(this.pool, async (tx) => {
        const exportId = randomUUID();
        await tx.query(
          `INSERT INTO workspace_exports (
             id, org_id, workspace_id, requested_by, checkpoint_id,
             record_revision, content_revision, include_chats,
             idempotency_key, request_sha256, state, export_blob_id,
             available_at, expires_at, completed_at, fork_intent_id
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             'available', $11, now(), now() + interval '7 days', now(), $12
           )
           ON CONFLICT (fork_intent_id) DO NOTHING`,
          [
            exportId,
            row.org_id,
            row.source_cloud_workspace_id,
            row.requested_by,
            row.checkpoint_id,
            Number(row.record_revision),
            Number(row.content_revision),
            row.include_chats,
            `fork.${row.id}.export`,
            digest(descriptor),
            manifest.id,
            row.id,
          ],
        );
        const stored = await tx.query<{ id: string }>(
          `SELECT id FROM workspace_exports WHERE fork_intent_id = $1`,
          [row.id],
        );
        await addReferences(tx, {
          organizationId: row.org_id,
          workspaceId: row.source_cloud_workspace_id,
          kind: "export",
          referenceId: stored.rows[0]!.id,
          blobIds: [manifest.id],
        });
        await tx.query(
          `UPDATE workspace_fork_intents
           SET state = 'succeeded', source_checkpoint_id = $3,
               export_id = $4, result_blob_id = $5,
               lease_owner = NULL, lease_expires_at = NULL,
               completed_at = now(), updated_at = now(), error_code = NULL
           WHERE id = $1 AND org_id = $2 AND state = 'exporting'
             AND lease_owner = $6`,
          [
            row.id,
            row.org_id,
            row.checkpoint_id,
            stored.rows[0]!.id,
            manifest.id,
            this.workerId,
          ],
        );
        await audit(
          tx,
          row.org_id,
          row.requested_by,
          "cloud_workspace.local_copy_ready",
          {
            forkIntentId: row.id,
            sourceCloudWorkspaceId: row.source_cloud_workspace_id,
            targetLocalWorkspaceId: row.target_local_workspace_id,
            checkpointId: row.checkpoint_id,
            exportId: stored.rows[0]!.id,
          },
        );
      });
    } catch {
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE workspace_fork_intents
           SET state = CASE WHEN attempt_count >= 10 THEN 'failed' ELSE 'requested' END,
               completed_at = CASE WHEN attempt_count >= 10 THEN now() ELSE NULL END,
               error_code = 'export_build_failed', lease_owner = NULL,
               lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND state = 'exporting' AND lease_owner = $2`,
          [row.id, this.workerId],
        ),
      );
    }
    return true;
  }
}

export function forkErrorToHttp(error: WorkspaceForkError): HttpError {
  const status: 403 | 404 | 409 | 422 =
    error.code === "not_found"
      ? 404
      : ["device_proof_rejected", "grant_rejected"].includes(error.code)
        ? 403
        : error.code === "invalid_input"
          ? 422
          : 409;
  return new HttpError(status, `workspace_fork_${error.code}`, error.message);
}
