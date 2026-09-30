import { z } from "zod";
import { cloudAccountRequest } from "./cloud-workspaces";
import {
  cloudScopedId,
  cloudWorkspaceKey,
  parseCloudScopedId,
  parseCloudWorkspaceKey,
  type CloudWorkspaceTarget,
} from "./bridge/cloud-workspace-key";
import type { WireRecord } from "./bridge/cloud-runtime-wire";
import { getOrganizationStoreGeneration } from "../features/team/team-store";

const baseSchema = {
  workspaceId: z.string().uuid(),
  organizationId: z.string().uuid(),
  revision: z.number().int().safe().nonnegative(),
};
const chatsSchema = z.object({
  ...baseSchema,
  chats: z
    .array(z.object({ id: z.string(), folder: z.string() }).passthrough())
    .max(200),
  chatDeletions: z.array(z.string()).max(200),
  nextCursor: z.string().nullable(),
});
const messagesSchema = z.object({
  ...baseSchema,
  messages: z
    .array(
      z.object({
        msgId: z.string(),
        kind: z.string(),
        payload: z.string(),
        createdAt: z.number().int().safe().nonnegative(),
      }),
    )
    .max(1000),
});
const searchSchema = z.object({
  ...baseSchema,
  hits: z.array(z.object({ chatId: z.string().min(1).max(255), msgId: z.string().min(1).max(255),
    payload: z.string(), createdAt: z.number().int().safe().nonnegative() })).max(200),
  nextCursor: z.string().max(1024).nullable(),
});
function assertScope(
  target: CloudWorkspaceTarget,
  value: { workspaceId: string; organizationId: string },
) {
  if (
    target.workspaceId !== value.workspaceId ||
    target.organizationId !== value.organizationId
  )
    throw new Error("Cloud history returned a different workspace");
}

/** One cloud-owned read path for the existing transcript UI. No native runtime
 * or provider connection is opened to retrieve saved conversation data. */
export async function readCloudWorkspaceHistory(
  target: CloudWorkspaceTarget,
  op: string,
  params: WireRecord,
): Promise<WireRecord> {
  const generation = getOrganizationStoreGeneration();
  const assertAccount = () => {
    if (generation !== getOrganizationStoreGeneration())
      throw new Error("Cloud account changed while loading history");
  };
  const root = `/v1/organizations/${z.string().uuid().parse(target.organizationId)}/cloud-workspaces/${z.string().uuid().parse(target.workspaceId)}/history`;
  if (op === "messages.search") {
    const queryText = z.string().max(1000).parse(params.query);
    const limit = Math.min(200, z.number().int().positive().parse(params.limit ?? 50));
    const query = new URLSearchParams({ query: queryText, limit: String(limit) });
    if (params.chatId !== undefined) {
      const chat = parseCloudScopedId(params.chatId);
      if (!chat || cloudWorkspaceKey(chat) !== cloudWorkspaceKey(target))
        throw new Error("Cloud conversation belongs to another workspace");
      query.set("chatId", chat.id);
    }
    if (params.folder !== undefined) {
      const folder = parseCloudWorkspaceKey(params.folder);
      if (!folder || cloudWorkspaceKey(folder) !== cloudWorkspaceKey(target))
        throw new Error("Cloud search belongs to another workspace");
      // The existing search contract gives chatId precedence over folder.
      if (!query.has("chatId")) query.set("folder", folder.relativePath || ".");
    }
    for (let attempt = 0; ; attempt++) {
      const hits: WireRecord[] = [], seen = new Set<string>();
      let cursor: string | null = null, revision: number | undefined, bytes = 0;
      try {
        do {
          query.set("limit", String(limit - hits.length));
          if (cursor) query.set("cursor", cursor); else query.delete("cursor");
          if (revision !== undefined) query.set("revision", String(revision)); else query.delete("revision");
          const page = await cloudAccountRequest(`${root}/search?${query}`, searchSchema);
          assertAccount(); assertScope(target, page);
          bytes += JSON.stringify(page).length * 2;
          if (bytes > 8 * 1024 * 1024 || hits.length + page.hits.length > limit)
            throw new Error("Cloud search exceeded its result limit");
          if (revision !== undefined && revision !== page.revision)
            throw new Error("Cloud history changed while searching");
          revision = page.revision;
          hits.push(...page.hits.map(row => {
            if (query.has("chatId") && row.chatId !== query.get("chatId"))
              throw new Error("Cloud search returned a different conversation");
            return { ...row, chatId: cloudScopedId(target, row.chatId) };
          }));
          cursor = page.nextCursor;
          if (cursor && (seen.has(cursor) || seen.size >= 50))
            throw new Error("Cloud search exceeded its page limit; narrow the query");
          if (cursor) seen.add(cursor);
        } while (cursor && hits.length < limit);
        return { hits };
      } catch (error) {
        assertAccount();
        if (attempt === 0 && (error as { code?: string }).code === "cloud_history_changed") continue;
        throw error;
      }
    }
  }
  if (op === "chats.list") {
    // A concurrent write may invalidate a multi-page snapshot. Retry once from
    // the beginning; never publish a partial list as authoritative emptiness.
    for (let attempt = 0; ; attempt++) {
      try {
        const chats: WireRecord[] = [],
          chatDeletions: string[] = [];
        let cursor: string | null = null,
          revision: number | undefined,
          bytes = 0;
        const seen = new Set<string>();
        do {
          const query = new URLSearchParams({ limit: "100" });
          if (cursor) query.set("afterId", cursor);
          if (revision !== undefined) query.set("revision", String(revision));
          const page = await cloudAccountRequest(
            `${root}/chats?${query}`,
            chatsSchema,
          );
          assertAccount();
          assertScope(target, page);
          bytes += JSON.stringify(page).length * 2;
          if (bytes > 8 * 1024 * 1024)
            throw new Error("Cloud history exceeded its metadata limit");
          if (revision !== undefined && revision !== page.revision)
            throw new Error("Cloud history changed while loading");
          revision = page.revision;
          for (const row of page.chats) {
            if (
              row.folder !== "." &&
              (!row.folder ||
                // eslint-disable-next-line no-control-regex -- reject control characters at the remote path boundary
                /[\u0000-\u001f\u007f\\]/u.test(row.folder) ||
                row.folder
                  .split("/")
                  .some((part) => !part || part === "." || part === ".."))
            )
              throw new Error("Cloud conversation folder is invalid");
            chats.push({
              ...row,
              id: cloudScopedId(target, row.id),
              folder:
                cloudWorkspaceKey(target) +
                (row.folder === "." ? "" : `/${row.folder}`),
              ...(typeof row.sourceChatId === "string"
                ? { sourceChatId: cloudScopedId(target, row.sourceChatId) }
                : {}),
              ...(typeof row.sessionId === "string"
                ? { sessionId: cloudScopedId(target, row.sessionId) }
                : {}),
            });
          }
          chatDeletions.push(
            ...page.chatDeletions.map((value) => cloudScopedId(target, value)),
          );
          cursor = page.nextCursor;
          if (
            cursor &&
            (seen.has(cursor) || chats.length + chatDeletions.length >= 10_000)
          )
            throw new Error("Cloud history exceeded its page limit");
          if (cursor) seen.add(cursor);
        } while (cursor);
        // Messages can change without a chat title changing. Preserve the
        // database revision so quiet metadata polls remain distinguishable
        // from a real history update, including while the worker is stopped.
        return { chats, chatDeletions, revision };
      } catch (error) {
        assertAccount();
        if (
          attempt === 0 &&
          (error as { code?: string }).code === "cloud_history_changed"
        )
          continue;
        throw error;
      }
    }
  }
  if (op !== "messages.window" && op !== "messages.windowOlder")
    throw new Error("Unsupported cloud history read");
  const chat = parseCloudScopedId(params.chatId);
  if (!chat || cloudWorkspaceKey(chat) !== cloudWorkspaceKey(target))
    throw new Error("Cloud conversation belongs to another workspace");
  const limit = z
    .number()
    .int()
    .positive()
    .parse(params.limit ?? 200);
  const query = new URLSearchParams({ limit: String(Math.min(limit, 1000)) });
  if (op === "messages.windowOlder")
    query.set("beforeMsgId", z.string().min(1).parse(params.beforeMsgId));
  else if (params.before !== undefined)
    query.set(
      "before",
      String(z.number().int().safe().nonnegative().parse(params.before)),
    );
  const page = await cloudAccountRequest(
    `${root}/messages/${encodeURIComponent(chat.id)}?${query}`,
    messagesSchema,
  );
  assertAccount();
  assertScope(target, page);
  return { messages: page.messages };
}
