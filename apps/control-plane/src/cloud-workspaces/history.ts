import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { authorizeCloudWorkspaceActor } from "./actors.js";
import { lockCloudWorkspaceScope } from "./authorization.js";

type Scope = {
  workspaceId: string;
  organizationId: string;
  accountUserId: string;
};
type Entity = {
  entity_id: string;
  schema_version: number;
  document: unknown;
  tombstoned_at: Date | null;
};
const id = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const chatDocument = z.object({
  version: z.literal(1),
  chat: z.object({ id, folder: z.string() }).passthrough(),
});
const messageDocument = z.object({
  version: z.literal(1),
  chatId: id,
  msgId: id,
  ord: z.number().int().safe().nonnegative(),
  kind: z.string(),
  payload: z.string(),
  createdAt: z.number().int().safe().nonnegative(),
});
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_MESSAGES = 1000;
const invalid = () =>
  new HttpError(422, "invalid_input", "Invalid cloud history request");
const corrupt = () =>
  new HttpError(
    503,
    "cloud_history_unavailable",
    "Cloud history is temporarily unavailable",
  );

function validateLimit(limit: number, max: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) throw invalid();
}
function validFolder(folder: string): boolean {
  return (
    folder === "." ||
    (folder.length > 0 &&
      !folder.includes("\\") &&
      !/[\u0000-\u001f\u007f]/u.test(folder) &&
      folder
        .split("/")
        .every((part) => !!part && part !== "." && part !== ".."))
  );
}

/** Read the cloud-owned transcript projection without engine admission, a
 * compute lease or a provider call. Every page rechecks the acting account. */
export class DatabaseCloudWorkspaceHistoryService {
  constructor(private readonly pool: pg.Pool) {}

  private read<T>(
    scope: Scope,
    body: (tx: Tx, revision: number) => Promise<T>,
  ): Promise<T> {
    return withSystemTx(this.pool, async (tx) => {
      if (
        !(await lockCloudWorkspaceScope(tx, {
          ...scope,
          organizationLock: "share",
          workspaceLock: "share",
        }))
      )
        throw new HttpError(404, "not_found", "Workspace not found");
      await authorizeCloudWorkspaceActor(tx, {
        ...scope,
        actorUserId: scope.accountUserId,
        capability: "read",
        allowOwnerDataRecovery: true,
      });
      // Append holds this same row FOR UPDATE. A page's metadata, tombstones
      // and messages therefore belong to one confirmed projection revision.
      const head = (
        await tx.query<{ current_revision: string }>(
          "SELECT current_revision FROM workspace_record_heads WHERE workspace_id=$1 AND org_id=$2 FOR SHARE",
          [scope.workspaceId, scope.organizationId],
        )
      ).rows[0];
      return body(tx, Number(head?.current_revision ?? 0));
    });
  }

  /** Search a bounded slice of the saved projection. A continuation may have
   * no hits: the cursor advances over scanned rows, so sparse matches never
   * require an unbounded database scan or a worker wake. */
  async search(input: Scope & {
    query: string;
    limit: number;
    chatId?: string | undefined;
    folder?: string | undefined;
    cursor?: string | undefined;
    revision?: number | undefined;
  }) {
    validateLimit(input.limit, 200);
    if (typeof input.query !== "string" || input.query.length > 1000 || /[\u0000-\u001f\u007f]/u.test(input.query) ||
        (input.chatId !== undefined && !id.safeParse(input.chatId).success) ||
        (input.folder !== undefined && (!validFolder(input.folder) || input.folder.length > 4096)) ||
        (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 0)) ||
        (input.cursor !== undefined && (input.cursor.length > 1024 || input.revision === undefined))) throw invalid();
    return this.read(input, async (tx, revision) => {
      if (input.revision !== undefined && input.revision !== revision)
        throw new HttpError(409, "cloud_history_changed", "Cloud history changed while loading; retry the snapshot");
      const binding = createHash("sha256").update(JSON.stringify([
        input.workspaceId, input.organizationId, input.accountUserId, revision,
        input.query, input.chatId ?? null, input.folder ?? null,
      ])).digest("hex");
      let after: string | null = null;
      if (input.cursor !== undefined) {
        try {
          const cursor = z.object({ after: z.string().regex(/^m:[a-f0-9]{64}$/), binding: z.literal(binding) }).strict()
            .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
          after = cursor.after;
        } catch { throw invalid(); }
      }
      const hits: Array<{ chatId: string; msgId: string; payload: string; createdAt: number }> = [];
      const result = (nextCursor: string | null) => ({ workspaceId: input.workspaceId, organizationId: input.organizationId, revision, hits, nextCursor });
      if (!input.query.trim() || revision === 0) return result(null);
      // Tenant predicates apply before paging, and only live chats participate.
      // Materialization bounds full-text tokenization as well as returned bytes.
      const scanLimit = 512;
      const rows = (await tx.query<Entity & { matches: boolean; overflow: boolean }>(`
        WITH candidates AS MATERIALIZED (
          SELECT m.entity_id,m.schema_version,m.document,m.tombstoned_at
          FROM workspace_record_entities m
          JOIN workspace_record_entities c ON c.workspace_id=m.workspace_id AND c.org_id=m.org_id
            AND c.entity_kind='chat' AND c.entity_id=m.document->>'chatId' AND c.tombstoned_at IS NULL
          WHERE m.workspace_id=$1 AND m.org_id=$2 AND m.entity_kind='message' AND m.tombstoned_at IS NULL
            AND ($3::text IS NULL OR m.document->>'chatId'=$3)
            AND ($4::text IS NULL OR c.document->'chat'->>'folder'=$4)
            AND ($5::text IS NULL OR m.entity_id>$5)
          ORDER BY m.entity_id LIMIT $6
        ), bounded AS MATERIALIZED (
          SELECT *,sum(octet_length(document::text)+512) OVER (ORDER BY entity_id) AS bytes FROM candidates
        )
        SELECT entity_id,schema_version,document,tombstoned_at,bytes>$7 AS overflow,
          CASE WHEN bytes<=$7 THEN to_tsvector('simple',document->>'payload') @@ plainto_tsquery('simple',$8) ELSE false END AS matches
        FROM bounded WHERE bytes<=$7 OR entity_id=(SELECT entity_id FROM bounded WHERE bytes>$7 ORDER BY entity_id LIMIT 1)
        ORDER BY entity_id`, [input.workspaceId, input.organizationId, input.chatId ?? null,
        input.folder ?? null, after, scanLimit + 1, MAX_BYTES, input.query])).rows;
      let consumed = 0;
      for (const row of rows.slice(0, scanLimit)) {
        if (row.overflow || hits.length >= input.limit) break;
        const parsed = messageDocument.safeParse(row.document);
        if (row.schema_version !== 1 || !parsed.success ||
            row.entity_id !== `m:${createHash("sha256").update(`${parsed.data.chatId}\0${parsed.data.msgId}`).digest("hex")}`) throw corrupt();
        if (row.matches) {
          const { chatId, msgId, payload, createdAt } = parsed.data;
          hits.push({ chatId, msgId, payload, createdAt });
        }
        consumed++;
      }
      if (rows.length > 0 && consumed === 0) throw corrupt();
      return result(rows.length > consumed
        ? Buffer.from(JSON.stringify({ after: rows[consumed - 1]!.entity_id, binding })).toString("base64url") : null);
    });
  }

  async chats(
    input: Scope & {
      limit: number;
      afterId?: string | undefined;
      revision?: number | undefined;
    },
  ) {
    validateLimit(input.limit, 200);
    if (
      (input.afterId !== undefined && !id.safeParse(input.afterId).success) ||
      (input.revision !== undefined &&
        (!Number.isSafeInteger(input.revision) || input.revision < 0))
    )
      throw invalid();
    return this.read(input, async (tx, revision) => {
      if (input.revision !== undefined && input.revision !== revision)
        throw new HttpError(
          409,
          "cloud_history_changed",
          "Cloud history changed while loading; retry the snapshot",
        );
      const rows =
        revision === 0
          ? []
          : (
              await tx.query<Entity & { overflow: boolean }>(
                `WITH candidates AS MATERIALIZED (SELECT entity_id,schema_version,document,tombstoned_at
        FROM workspace_record_entities WHERE workspace_id=$1 AND org_id=$2 AND entity_kind='chat'
          AND ($3::text IS NULL OR entity_id>$3) ORDER BY entity_id LIMIT $4), bounded AS (
          SELECT *,sum(coalesce(octet_length(document::text),0)+512) OVER (ORDER BY entity_id) AS bytes FROM candidates)
        SELECT entity_id,schema_version,document,tombstoned_at,bytes>$5 AS overflow FROM bounded
        WHERE bytes<=$5 OR entity_id=(SELECT entity_id FROM bounded WHERE bytes>$5 ORDER BY entity_id LIMIT 1) ORDER BY entity_id`,
                [
                  input.workspaceId,
                  input.organizationId,
                  input.afterId ?? null,
                  input.limit + 1,
                  MAX_BYTES,
                ],
              )
            ).rows;
      const chats: Array<
        Record<string, unknown> & { id: string; folder: string }
      > = [];
      const chatDeletions: string[] = [];
      let consumed = 0;
      for (const row of rows.slice(0, input.limit)) {
        // The extra row proves more data exists without a second query. Use
        // SQL's byte accounting for consumption as well as the page boundary.
        if (row.overflow) break;
        if (row.tombstoned_at) chatDeletions.push(row.entity_id);
        else {
          const parsed = chatDocument.safeParse(row.document);
          if (
            row.schema_version !== 1 ||
            !parsed.success ||
            parsed.data.chat.id !== row.entity_id ||
            !validFolder(parsed.data.chat.folder)
          )
            throw corrupt();
          chats.push(parsed.data.chat);
        }
        consumed++;
      }
      if (rows.length > 0 && consumed === 0) throw corrupt();
      return {
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        revision,
        chats,
        chatDeletions,
        nextCursor:
          rows.length > consumed ? rows[consumed - 1]!.entity_id : null,
      };
    });
  }

  async messages(
    input: Scope & {
      chatId: string;
      limit: number;
      beforeMsgId?: string | undefined;
      before?: number | undefined;
    },
  ) {
    validateLimit(input.limit, MAX_MESSAGES);
    if (
      !id.safeParse(input.chatId).success ||
      (input.beforeMsgId !== undefined &&
        !id.safeParse(input.beforeMsgId).success) ||
      (input.before !== undefined &&
        (!Number.isSafeInteger(input.before) || input.before < 0)) ||
      (input.before !== undefined && input.beforeMsgId !== undefined)
    )
      throw invalid();
    return this.read(input, async (tx, revision) => {
      const chat =
        revision === 0
          ? null
          : (
              await tx.query(
                "SELECT 1 FROM workspace_record_entities WHERE workspace_id=$1 AND org_id=$2 AND entity_kind='chat' AND entity_id=$3 AND tombstoned_at IS NULL",
                [input.workspaceId, input.organizationId, input.chatId],
              )
            ).rows[0];
      if (!chat)
        throw new HttpError(404, "not_found", "Conversation not found");
      const result = (
        messages: Array<{
          msgId: string;
          kind: string;
          payload: string;
          createdAt: number;
        }>,
      ) => ({
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        revision,
        messages,
      });
      let before = input.before;
      if (input.beforeMsgId !== undefined) {
        const entity = `m:${createHash("sha256").update(`${input.chatId}\0${input.beforeMsgId}`).digest("hex")}`;
        const cursor = (
          await tx.query<{ document: unknown }>(
            "SELECT document FROM workspace_record_entities WHERE workspace_id=$1 AND org_id=$2 AND entity_kind='message' AND entity_id=$3 AND tombstoned_at IS NULL",
            [input.workspaceId, input.organizationId, entity],
          )
        ).rows[0];
        if (!cursor) return result([]);
        const parsed = messageDocument.safeParse(cursor.document);
        if (
          !parsed.success ||
          parsed.data.chatId !== input.chatId ||
          parsed.data.msgId !== input.beforeMsgId
        )
          throw corrupt();
        before = parsed.data.ord;
      }
      // SQL bounds both rows and bytes before materializing tool payloads in
      // the API process. JSON numeric ordering uses the matching partial index.
      const raw = (
        await tx.query<Entity>(
          `WITH candidates AS MATERIALIZED (
        SELECT entity_id,schema_version,document,tombstoned_at FROM workspace_record_entities
        WHERE workspace_id=$1 AND org_id=$2 AND entity_kind='message' AND tombstoned_at IS NULL
          AND document->>'chatId'=$3 AND ($4::bigint IS NULL OR document->'ord'<to_jsonb($4::bigint))
        ORDER BY document->'ord' DESC,entity_id LIMIT $5
      ), bounded AS (SELECT *,sum(octet_length(document::text)) OVER (ORDER BY document->'ord' DESC,entity_id) AS bytes FROM candidates)
      SELECT entity_id,schema_version,document,tombstoned_at FROM bounded WHERE bytes<=$6 ORDER BY document->'ord' DESC,entity_id`,
          [
            input.workspaceId,
            input.organizationId,
            input.chatId,
            before ?? null,
            before === undefined ? MAX_MESSAGES : input.limit,
            MAX_BYTES,
          ],
        )
      ).rows;
      const rows = raw.map((row) => {
        const parsed = messageDocument.safeParse(row.document);
        if (
          row.schema_version !== 1 ||
          !parsed.success ||
          parsed.data.chatId !== input.chatId ||
          row.entity_id !==
            `m:${createHash("sha256").update(`${input.chatId}\0${parsed.data.msgId}`).digest("hex")}`
        )
          throw corrupt();
        return parsed.data;
      });
      let count = Math.min(input.limit, rows.length);
      const user = (index: number, opening: boolean) => {
        const row = rows[index];
        if (!row || row.kind !== "text") return false;
        try {
          const payload = JSON.parse(row.payload);
          return (
            payload.role === "user" && (!opening || !payload.steeredTurnId)
          );
        } catch {
          return false;
        }
      };
      // Match the existing transcript window: keep its opening prompt when a
      // tool-heavy turn crosses the requested tail, with a 1000-row ceiling.
      if (before === undefined && count > 0 && !user(count - 1, false)) {
        let start = rows.findIndex(
          (_, index) => index >= count && user(index, true),
        );
        if (start < 0)
          start = rows.findIndex(
            (_, index) => index >= count && user(index, false),
          );
        if (start >= 0) count = start + 1;
      }
      return result(
        rows
          .slice(0, count)
          .reverse()
          .map(({ msgId, kind, payload, createdAt }) => ({
            msgId,
            kind,
            payload,
            createdAt,
          })),
      );
    });
  }
}
