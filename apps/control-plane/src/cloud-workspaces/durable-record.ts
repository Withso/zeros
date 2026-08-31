import { createHash, timingSafeEqual } from "node:crypto";

import type pg from "pg";

import { audit } from "../audit.js";
import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";
import { authorizeCloudWorkspaceOperation } from "./authorization.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";

const ENTITY_KINDS = new Set([
  "workspace",
  "chat",
  "message",
  "turn",
  "agent_session",
  "run",
  "terminal",
  "design_transaction",
  "metadata",
] as const);
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;

export type WorkspaceRecordEntityKind =
  | "workspace"
  | "chat"
  | "message"
  | "turn"
  | "agent_session"
  | "run"
  | "terminal"
  | "design_transaction"
  | "metadata";

export type WorkspaceRecordMutation = {
  entityKind: WorkspaceRecordEntityKind;
  entityId: string;
  operation: "upsert" | "tombstone";
  schemaVersion: number;
  document?: Record<string, unknown>;
  occurredAt: string;
};

export type WorkspaceRecordAppendResult = {
  firstRevision: number;
  lastRevision: number;
  currentRevision: number;
  replayed: boolean;
};

export class WorkspaceRecordError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "engine_authority_rejected"
      | "revision_conflict"
      | "idempotency_conflict",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceRecordError";
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!plainRecord(value)) throw new WorkspaceRecordError("invalid_input", "Invalid record document");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function inspectJson(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): void {
  state.nodes += 1;
  if (state.nodes > 20_000 || depth > 32) {
    throw new WorkspaceRecordError("invalid_input", "Record document is too complex");
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
    for (const entry of value) inspectJson(entry, state, depth + 1);
    return;
  }
  if (!plainRecord(value)) {
    throw new WorkspaceRecordError("invalid_input", "Invalid record document");
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      key.length < 1 ||
      key.length > 256 ||
      ["__proto__", "constructor", "prototype"].includes(key)
    ) {
      throw new WorkspaceRecordError("invalid_input", "Invalid record document key");
    }
    inspectJson(entry, state, depth + 1);
  }
}

function validateMutations(
  mutations: readonly WorkspaceRecordMutation[],
  nowMs: number,
): WorkspaceRecordMutation[] {
  if (mutations.length < 1 || mutations.length > 100) {
    throw new WorkspaceRecordError("invalid_input", "Record batch size is invalid");
  }
  const normalized = mutations.map((mutation) => {
    if (
      !ENTITY_KINDS.has(mutation.entityKind) ||
      typeof mutation.entityId !== "string" ||
      mutation.entityId.length < 1 ||
      mutation.entityId.length > 255 ||
      /[\u0000-\u001f\u007f]/u.test(mutation.entityId) ||
      !["upsert", "tombstone"].includes(mutation.operation) ||
      !Number.isSafeInteger(mutation.schemaVersion) ||
      mutation.schemaVersion < 1 ||
      mutation.schemaVersion > 65_535
    ) {
      throw new WorkspaceRecordError("invalid_input", "Record mutation is invalid");
    }
    const occurredAt = new Date(mutation.occurredAt);
    if (
      !Number.isFinite(occurredAt.getTime()) ||
      Math.abs(occurredAt.getTime() - nowMs) > 24 * 60 * 60_000
    ) {
      throw new WorkspaceRecordError("invalid_input", "Record timestamp is invalid");
    }
    if (mutation.operation === "upsert") {
      if (!plainRecord(mutation.document)) {
        throw new WorkspaceRecordError("invalid_input", "Upsert document is required");
      }
      inspectJson(mutation.document, { nodes: 0 });
      const serialized = canonicalJson(mutation.document);
      if (Buffer.byteLength(serialized, "utf8") > MAX_DOCUMENT_BYTES) {
        throw new WorkspaceRecordError("invalid_input", "Record document is too large");
      }
      return {
        ...mutation,
        occurredAt: occurredAt.toISOString(),
        document: JSON.parse(serialized) as Record<string, unknown>,
      };
    }
    if (mutation.document !== undefined) {
      throw new WorkspaceRecordError("invalid_input", "Tombstones cannot carry a document");
    }
    return { ...mutation, occurredAt: occurredAt.toISOString() };
  });
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > MAX_BATCH_BYTES) {
    throw new WorkspaceRecordError("invalid_input", "Record batch is too large");
  }
  return normalized;
}

function sameHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export class DatabaseCloudWorkspaceDurableRecordService {
  private readonly pool: pg.Pool;
  private readonly workosEnabled: boolean;
  private readonly now: () => number;

  constructor(input: {
    pool: pg.Pool;
    workosEnabled: boolean;
    now?: () => number;
  }) {
    this.pool = input.pool;
    this.workosEnabled = input.workosEnabled;
    this.now = input.now ?? Date.now;
  }

  async append(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    engineInstanceId: string;
    heartbeatToken: string;
    expectedRevision: number;
    idempotencyKey: string;
    mutations: readonly WorkspaceRecordMutation[];
  }): Promise<WorkspaceRecordAppendResult> {
    if (
      !IDEMPOTENCY_PATTERN.test(input.idempotencyKey) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    ) {
      throw new WorkspaceRecordError("invalid_input", "Record append input is invalid");
    }
    const mutations = validateMutations(input.mutations, this.now());
    const digest = createHash("sha256")
      .update(
        canonicalJson({
          expectedRevision: input.expectedRevision,
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
          `INSERT INTO workspace_record_heads (workspace_id, org_id)
           VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING`,
          [input.workspaceId, input.organizationId],
        );
        const head = await tx.query<{ current_revision: string | number }>(
          `SELECT current_revision FROM workspace_record_heads
           WHERE workspace_id = $1 AND org_id = $2 FOR UPDATE`,
          [input.workspaceId, input.organizationId],
        );
        const currentRevision = Number(head.rows[0]?.current_revision);
        if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
          throw new Error("workspace record head is invalid");
        }
        const prior = await tx.query<{
          request_sha256: Buffer;
          first_revision: string | number;
          last_revision: string | number;
        }>(
          `SELECT request_sha256, first_revision, last_revision
           FROM workspace_record_batches
           WHERE workspace_id = $1 AND idempotency_key = $2`,
          [input.workspaceId, input.idempotencyKey],
        );
        if (prior.rows[0]) {
          if (!sameHash(prior.rows[0].request_sha256, digest)) {
            throw new WorkspaceRecordError(
              "idempotency_conflict",
              "Record idempotency key was reused",
            );
          }
          return {
            firstRevision: Number(prior.rows[0].first_revision),
            lastRevision: Number(prior.rows[0].last_revision),
            currentRevision,
            replayed: true,
          };
        }
        if (currentRevision !== input.expectedRevision) {
          throw new WorkspaceRecordError(
            "revision_conflict",
            "Record revision does not match the durable head",
          );
        }
        const firstRevision = currentRevision + 1;
        const lastRevision = currentRevision + mutations.length;
        const batch = await tx.query<{ id: string }>(
          `INSERT INTO workspace_record_batches (
             workspace_id, org_id, engine_instance_id, authority_epoch,
             idempotency_key, request_sha256, first_revision, last_revision,
             event_count
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            input.workspaceId,
            input.organizationId,
            input.engineInstanceId,
            authority.authorityEpoch,
            input.idempotencyKey,
            digest,
            firstRevision,
            lastRevision,
            mutations.length,
          ],
        );
        for (const [index, mutation] of mutations.entries()) {
          const revision = firstRevision + index;
          await tx.query(
            `INSERT INTO workspace_record_events (
               workspace_id, org_id, revision, batch_id, entity_kind,
               entity_id, operation, schema_version, document, actor_user_id,
               occurred_at
             ) VALUES (
               $1, $2, $3, $4, $5::workspace_record_entity_kind, $6,
               $7::workspace_record_event_operation, $8, $9::jsonb, $10, $11
             )`,
            [
              input.workspaceId,
              input.organizationId,
              revision,
              batch.rows[0]!.id,
              mutation.entityKind,
              mutation.entityId,
              mutation.operation,
              mutation.schemaVersion,
              mutation.operation === "upsert"
                ? JSON.stringify(mutation.document)
                : null,
              authority.accountUserId,
              mutation.occurredAt,
            ],
          );
          await tx.query(
            `INSERT INTO workspace_record_entities (
               workspace_id, org_id, entity_kind, entity_id, revision,
               schema_version, document, tombstoned_at
             ) VALUES (
               $1, $2, $3::workspace_record_entity_kind, $4, $5, $6,
               $7::jsonb, CASE WHEN $7::jsonb IS NULL THEN $8::timestamptz END
             )
             ON CONFLICT (workspace_id, entity_kind, entity_id) DO UPDATE SET
               revision = EXCLUDED.revision,
               schema_version = EXCLUDED.schema_version,
               document = EXCLUDED.document,
               tombstoned_at = EXCLUDED.tombstoned_at,
               updated_at = now()
             WHERE workspace_record_entities.revision < EXCLUDED.revision`,
            [
              input.workspaceId,
              input.organizationId,
              mutation.entityKind,
              mutation.entityId,
              revision,
              mutation.schemaVersion,
              mutation.operation === "upsert"
                ? JSON.stringify(mutation.document)
                : null,
              mutation.occurredAt,
            ],
          );
        }
        await tx.query(
          `UPDATE workspace_record_heads
           SET current_revision = $2, last_durable_at = now(), updated_at = now()
           WHERE workspace_id = $1`,
          [input.workspaceId, lastRevision],
        );
        await tx.query(
          `INSERT INTO cloud_workspace_outbox (
             org_id, workspace_id, event_type, aggregate_key,
             aggregate_revision, idempotency_key, payload
           ) VALUES (
             $1, $2, 'workspace.record_appended', $3, $4, $5, $6::jsonb
           )`,
          [
            input.organizationId,
            input.workspaceId,
            `workspace-record:${input.workspaceId}`,
            lastRevision,
            `record:${input.workspaceId}:${input.idempotencyKey}`,
            JSON.stringify({
              workspaceId: input.workspaceId,
              firstRevision,
              lastRevision,
              eventCount: mutations.length,
              authorityEpoch: authority.authorityEpoch,
            }),
          ],
        );
        await audit(
          tx,
          input.organizationId,
          authority.accountUserId,
          "workspace.record_appended",
          {
            workspaceId: input.workspaceId,
            firstRevision,
            lastRevision,
            eventCount: mutations.length,
            authorityEpoch: authority.authorityEpoch,
          },
        );
        return {
          firstRevision,
          lastRevision,
          currentRevision: lastRevision,
          replayed: false,
        };
      });
    } catch (error) {
      if (error instanceof WorkspaceRecordError) throw error;
      if (
        error instanceof Error &&
        error.name === "CloudWorkspaceEngineAuthorityError"
      ) {
        throw new WorkspaceRecordError(
          "engine_authority_rejected",
          "Record append authority is not current",
        );
      }
      throw error;
    }
  }

  /** Exact current projection used only by the authoritative engine during
   * startup/recovery. Pagination is over a stable semantic key; the caller
   * must restart if currentRevision changes between pages. */
  async headForEngine(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    engineInstanceId: string;
    heartbeatToken: string;
    afterEntityKind: WorkspaceRecordEntityKind | null;
    afterEntityId: string | null;
    limit?: number;
  }): Promise<{
    currentRevision: number;
    entries: Array<{
      entityKind: WorkspaceRecordEntityKind;
      entityId: string;
      revision: number;
      schemaVersion: number;
      document: unknown;
      tombstonedAt: string | null;
    }>;
    next: { entityKind: WorkspaceRecordEntityKind; entityId: string } | null;
  }> {
    const limit = input.limit ?? 10;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10 ||
      ((input.afterEntityKind === null) !== (input.afterEntityId === null)) ||
      (input.afterEntityKind !== null && !ENTITY_KINDS.has(input.afterEntityKind)) ||
      (input.afterEntityId !== null &&
        (input.afterEntityId.length < 1 ||
          input.afterEntityId.length > 255 ||
          /[\u0000-\u001f\u007f]/u.test(input.afterEntityId)))
    ) {
      throw new WorkspaceRecordError("invalid_input", "Record head cursor is invalid");
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
        const head = await tx.query<{ current_revision: string | number }>(
          `SELECT current_revision FROM workspace_record_heads
           WHERE workspace_id = $1 AND org_id = $2 FOR SHARE`,
          [input.workspaceId, input.organizationId],
        );
        const rows = await tx.query<{
          entity_kind: WorkspaceRecordEntityKind;
          entity_id: string;
          revision: string | number;
          schema_version: number;
          document: unknown;
          tombstoned_at: Date | string | null;
        }>(
          `SELECT entity_kind, entity_id, revision, schema_version,
                  document, tombstoned_at
           FROM workspace_record_entities
           WHERE workspace_id = $1 AND org_id = $2
             AND (
               $3::text IS NULL
               OR (entity_kind::text, entity_id) > ($3::text, $4::text)
             )
           ORDER BY entity_kind::text, entity_id
           LIMIT $5`,
          [
            input.workspaceId,
            input.organizationId,
            input.afterEntityKind,
            input.afterEntityId,
            limit + 1,
          ],
        );
        const page = rows.rows.slice(0, limit);
        const last = page.at(-1);
        return {
          currentRevision: Number(head.rows[0]?.current_revision ?? 0),
          entries: page.map((row) => ({
            entityKind: row.entity_kind,
            entityId: row.entity_id,
            revision: Number(row.revision),
            schemaVersion: row.schema_version,
            document: row.document,
            tombstonedAt:
              row.tombstoned_at === null
                ? null
                : new Date(row.tombstoned_at).toISOString(),
          })),
          next:
            rows.rows.length > limit && last
              ? { entityKind: last.entity_kind, entityId: last.entity_id }
              : null,
        };
      });
    } catch (error) {
      if (error instanceof WorkspaceRecordError) throw error;
      if (
        error instanceof Error &&
        error.name === "CloudWorkspaceEngineAuthorityError"
      ) {
        throw new WorkspaceRecordError(
          "engine_authority_rejected",
          "Record head authority is not current",
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
    minimumRetainedRevision: number;
    snapshotRequired: boolean;
    entities: Array<{
      entityKind: WorkspaceRecordEntityKind;
      entityId: string;
      revision: number;
      schemaVersion: number;
      document: unknown;
      tombstonedAt: string | null;
    }>;
    events: Array<{
      revision: number;
      entityKind: WorkspaceRecordEntityKind;
      entityId: string;
      operation: "upsert" | "tombstone";
      schemaVersion: number;
      document: unknown;
      occurredAt: string;
    }>;
    hasMore: boolean;
  }> {
    const limit = input.limit ?? 200;
    if (
      !Number.isSafeInteger(input.afterRevision) ||
      input.afterRevision < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new HttpError(422, "invalid_input", "Record cursor is invalid");
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
        minimum_retained_revision: string | number;
      }>(
        `SELECT current_revision, minimum_retained_revision
         FROM workspace_record_heads
         WHERE workspace_id = $1 AND org_id = $2 FOR SHARE`,
        [input.workspaceId, input.organizationId],
      );
      const currentRevision = Number(head.rows[0]?.current_revision ?? 0);
      const minimumRetainedRevision = Number(
        head.rows[0]?.minimum_retained_revision ?? 0,
      );
      const snapshotRequired = input.afterRevision < minimumRetainedRevision;
      const entities = snapshotRequired
        ? (
            await tx.query<{
              entity_kind: WorkspaceRecordEntityKind;
              entity_id: string;
              revision: string | number;
              schema_version: number;
              document: unknown;
              tombstoned_at: Date | string | null;
            }>(
              `SELECT entity_kind, entity_id, revision, schema_version,
                      document, tombstoned_at
               FROM workspace_record_entities
               WHERE workspace_id = $1 AND org_id = $2
               ORDER BY entity_kind, entity_id`,
              [input.workspaceId, input.organizationId],
            )
          ).rows.map((row) => ({
            entityKind: row.entity_kind,
            entityId: row.entity_id,
            revision: Number(row.revision),
            schemaVersion: row.schema_version,
            document: row.document,
            tombstonedAt:
              row.tombstoned_at === null
                ? null
                : new Date(row.tombstoned_at).toISOString(),
          }))
        : [];
      const startRevision = snapshotRequired
        ? currentRevision
        : input.afterRevision;
      const rows = (
        await tx.query<{
          revision: string | number;
          entity_kind: WorkspaceRecordEntityKind;
          entity_id: string;
          operation: "upsert" | "tombstone";
          schema_version: number;
          document: unknown;
          occurred_at: Date | string;
        }>(
          `SELECT revision, entity_kind, entity_id, operation,
                  schema_version, document, occurred_at
           FROM workspace_record_events
           WHERE workspace_id = $1 AND org_id = $2 AND revision > $3
           ORDER BY revision
           LIMIT $4`,
          [input.workspaceId, input.organizationId, startRevision, limit + 1],
        )
      ).rows;
      const hasMore = rows.length > limit;
      return {
        currentRevision,
        minimumRetainedRevision,
        snapshotRequired,
        entities,
        events: rows.slice(0, limit).map((row) => ({
          revision: Number(row.revision),
          entityKind: row.entity_kind,
          entityId: row.entity_id,
          operation: row.operation,
          schemaVersion: row.schema_version,
          document: row.document,
          occurredAt: new Date(row.occurred_at).toISOString(),
        })),
        hasMore,
      };
    });
  }
}
