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
import { captureCloudTranscriptConfirmation, forgetCloudTranscriptChat, installCloudHistoryRestoreMetadata,
  captureCloudHistoryRestoreRead, assertCloudHistoryRestoreResult } from "./cloud-transcript-cache";
import { CloudHistoryProjectionSchema, CloudHistoryRestoreHeadSchema, CloudHistoryRestoreMetadataSchema,
  type CloudHistoryRestoreMetadata } from "./cloud-transcript-cache-contract";

const baseSchema = {
  workspaceId: z.string().uuid(),
  organizationId: z.string().uuid(),
  revision: z.number().int().safe().nonnegative(),
  projection: CloudHistoryProjectionSchema.optional(),
  historyHeads: z.array(CloudHistoryRestoreHeadSchema).max(512).optional(),
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

function restoreMetadata(target: CloudWorkspaceTarget, value: WireRecord, conversationId?: string): CloudHistoryRestoreMetadata | null {
  if (value.projection === undefined && value.historyHeads === undefined) return null;
  const metadata = CloudHistoryRestoreMetadataSchema.parse({ projection: value.projection, historyHeads: value.historyHeads });
  assertScope(target, metadata.projection);
  if (conversationId !== undefined && (metadata.historyHeads.some(head => head.conversationId !== conversationId) ||
      metadata.projection.complete && metadata.historyHeads.length !== 1)) throw new Error("Cloud restore head belongs to another conversation");
  return metadata;
}
function appendMetadata(previous: CloudHistoryRestoreMetadata | null, next: CloudHistoryRestoreMetadata | null): CloudHistoryRestoreMetadata | null {
  if (!previous) return next;
  if (!next) throw new Error("Cloud history changed its writer mode while loading");
  const { complete: aComplete, ...a } = previous.projection, { complete: bComplete, ...b } = next.projection;
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("Cloud history changed its writer binding while loading");
  const heads = new Map(previous.historyHeads.map(head => [head.conversationId, head]));
  for (const head of next.historyHeads) {
    const known = heads.get(head.conversationId);
    if (known && JSON.stringify(known) !== JSON.stringify(head)) throw new Error("Cloud history changed its restore head while loading");
    heads.set(head.conversationId, head);
  }
  return CloudHistoryRestoreMetadataSchema.parse({ projection: { ...previous.projection, complete: aComplete && bComplete }, historyHeads: [...heads.values()] });
}
function hasCurrentRows(metadata: CloudHistoryRestoreMetadata | null, conversationId: string): boolean {
  if (!metadata) return true;
  const head = metadata.historyHeads.find(head => head.conversationId === conversationId);
  return !!head && !head.deleted && head.incompleteReason === null;
}
function assertCompletePage(metadata: CloudHistoryRestoreMetadata | null, conversations: readonly string[]): void {
  if (metadata?.projection.complete && conversations.some(id => !metadata.historyHeads.some(head => head.conversationId === id)))
    throw new Error("Cloud history omitted a current restore head");
}

/** One cloud-owned read path for the existing transcript UI. No native runtime
 * or provider connection is opened to retrieve saved conversation data. */
export async function readCloudWorkspaceHistory(
  target: CloudWorkspaceTarget,
  op: string,
  params: WireRecord,
): Promise<WireRecord> {
  const generation = getOrganizationStoreGeneration();
  const restoreRead = captureCloudHistoryRestoreRead(target);
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
      let cursor: string | null = null, revision: number | undefined, bytes = 0, metadata: CloudHistoryRestoreMetadata | null = null;
      try {
        do {
          query.set("limit", String(limit - hits.length));
          if (cursor) query.set("cursor", cursor); else query.delete("cursor");
          if (revision !== undefined) query.set("revision", String(revision)); else query.delete("revision");
          const page = await cloudAccountRequest(`${root}/search?${query}`, searchSchema);
          assertAccount(); assertScope(target, page);
          const pageMetadata = restoreMetadata(target, page, query.get("chatId") ?? undefined);
          assertCompletePage(pageMetadata, page.hits.map(row => row.chatId));
          const conversations = page.hits.map(row => row.chatId);
          if (query.has("chatId")) conversations.push(query.get("chatId")!);
          if (pageMetadata) await installCloudHistoryRestoreMetadata(target, pageMetadata, conversations, restoreRead);
          assertAccount(); assertCloudHistoryRestoreResult(restoreRead, pageMetadata, conversations);
          metadata = appendMetadata(metadata, pageMetadata);
          bytes += JSON.stringify(page).length * 2;
          if (bytes > 8 * 1024 * 1024 || hits.length + page.hits.length > limit)
            throw new Error("Cloud search exceeded its result limit");
          if (revision !== undefined && revision !== page.revision)
            throw new Error("Cloud history changed while searching");
          revision = page.revision;
          hits.push(...page.hits.filter(row => hasCurrentRows(pageMetadata, row.chatId)).map(row => {
            if (query.has("chatId") && row.chatId !== query.get("chatId"))
              throw new Error("Cloud search returned a different conversation");
            return { ...row, chatId: cloudScopedId(target, row.chatId) };
          }));
          cursor = page.nextCursor;
          if (cursor && (seen.has(cursor) || seen.size >= 50))
            throw new Error("Cloud search exceeded its page limit; narrow the query");
          if (cursor) seen.add(cursor);
        } while (cursor && hits.length < limit);
        assertCloudHistoryRestoreResult(restoreRead, metadata, hits.map(row => parseCloudScopedId(row.chatId)!.id));
        return { hits, ...(metadata ?? {}) };
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
        let metadata: CloudHistoryRestoreMetadata | null = null;
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
          const pageMetadata = restoreMetadata(target, page);
          assertCompletePage(pageMetadata, [...page.chats.map(row => row.id), ...page.chatDeletions]);
          const conversations = [...page.chats.map(row => row.id), ...page.chatDeletions];
          if (pageMetadata) await installCloudHistoryRestoreMetadata(target, pageMetadata, conversations, restoreRead);
          assertAccount(); assertCloudHistoryRestoreResult(restoreRead, pageMetadata, conversations);
          metadata = appendMetadata(metadata, pageMetadata);
          bytes += JSON.stringify(page).length * 2;
          if (bytes > 8 * 1024 * 1024)
            throw new Error("Cloud history exceeded its metadata limit");
          if (revision !== undefined && revision !== page.revision)
            throw new Error("Cloud history changed while loading");
          revision = page.revision;
          for (const row of page.chats) {
            if (pageMetadata?.historyHeads.find(head => head.conversationId === row.id)?.deleted) continue;
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
            ...(pageMetadata?.historyHeads.filter(head => head.deleted).map(head => cloudScopedId(target, head.conversationId)) ?? []),
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
        assertCloudHistoryRestoreResult(restoreRead, metadata,
          [...chats.map(row => parseCloudScopedId(row.id)!.id), ...chatDeletions.map(id => parseCloudScopedId(id)!.id)]);
        if (!metadata) for (const chatId of chatDeletions) forgetCloudTranscriptChat(chatId);
        return { chats, chatDeletions: [...new Set(chatDeletions)], revision, ...(metadata ?? {}) };
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
  const confirm = op === "messages.window" && params.before === undefined
    ? captureCloudTranscriptConfirmation(cloudScopedId(target, chat.id)) : null;
  const page = await cloudAccountRequest(
    `${root}/messages/${encodeURIComponent(chat.id)}?${query}`,
    messagesSchema,
  );
  assertAccount();
  assertScope(target, page);
  const metadata = restoreMetadata(target, page, chat.id);
  if (metadata) await installCloudHistoryRestoreMetadata(target, metadata, [chat.id], restoreRead);
  assertAccount(); assertCloudHistoryRestoreResult(restoreRead, metadata, [chat.id]);
  const messages = hasCurrentRows(metadata, chat.id) ? page.messages : [];
  if (op === "messages.window" && params.before === undefined) {
    const confirmed = metadata ? captureCloudTranscriptConfirmation(cloudScopedId(target, chat.id)) : confirm;
    if (hasCurrentRows(metadata, chat.id)) confirmed?.({
      recordEpoch: null, revision: page.revision, cursor: messages.at(-1)?.msgId ?? null, messages,
      ...(metadata ? { restoreHead: { projection: metadata.projection, conversationId: chat.id,
        head: metadata.historyHeads.find(head => head.conversationId === chat.id)! } } : {}),
    });
    return { messages, revision: page.revision, ...(metadata ?? {}) };
  }
  return { messages, ...(metadata ?? {}) };
}
