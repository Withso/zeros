import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudChatCacheStore } from "../cloud-chat-cache/store";
import { CloudChatCacheService } from "../cloud-chat-cache/service";
import { ControlPlaneCloudChatCacheSource } from "../cloud-chat-cache/source";

// Build 968: main fetched history for many real chats and stored one. These replies follow the shipped control
// plane's own shapes (history-cache.ts mirrorMessageRange/Delta, store.ts listChats) for a chat that existed before
// migration 0252 and has had no upload since: revision 0, a counted messageCount, a mid-turn window with turnOpening,
// Team senders (including null legacy attributions) and a worker historyState.
const base = "https://api.example.test";
const owner = JSON.stringify([base, "viewer-a"]);
const organizationId = "11111111-1111-4111-8111-111111111111", workspaceId = "22222222-2222-4222-8222-222222222222";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); });

function chat(count: number, options: { toolBytes?: number } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const user = index % 25 === 0;
    const msgId = user ? `user-${index}` : `${index.toString(36)}-tool_${index}`;
    const payload = user ? JSON.stringify({ id: msgId, kind: "text", role: "user", text: `prompt ${index}`, createdAt: 1_700_000_000_000 + index })
      : JSON.stringify({ id: msgId, kind: "tool", name: "Read", output: "x".repeat(options.toolBytes ?? 2_000), createdAt: 1_700_000_000_000 + index });
    return { msgId, kind: user ? "text" : "tool", payload, createdAt: 1_700_000_000_000 + index };
  });
}
function controlPlane(rows: ReturnType<typeof chat>, historyState?: unknown) {
  const calls: string[] = [];
  const range = (from: number, to: number) => {
    const fromIndex = Math.min(from, rows.length), toIndex = Math.min(to, rows.length);
    const slice = rows.slice(fromIndex, toIndex).map((row, offset) => ({ index: fromIndex + offset, ...row }));
    const first = slice[0];
    const opening = first && first.kind !== "text" ? [...rows.slice(0, fromIndex)].reverse().find(row => row.kind === "text") : undefined;
    const ids = [...slice, ...(opening ? [opening] : [])].filter(row => row.kind === "text").map(row => row.msgId);
    return { revision: 0, messageCount: rows.length, fromIndex, toIndex, rows: slice,
      ...(historyState ? { historyState } : {}), ...(opening ? { turnOpening: opening } : {}),
      senders: Object.fromEntries(ids.map((id, index) => [id, index % 2 ? null : { userId: "33333333-3333-4333-8333-333333333333" }])) };
  };
  const fetch = (async (url: string, init?: RequestInit) => {
    const pathname = new URL(url).pathname;
    if (pathname === `/v1/cloud-v2/workspaces/${workspaceId}`) {
      calls.push("workspace");
      return Response.json({ workspace: { id: workspaceId, organizationId, name: "w", state: "stopped" } });
    }
    const body = JSON.parse(String(init?.body)) as { op: string; params: { fromIndex: number; toIndex: number; revision: number } };
    calls.push(body.op);
    if (body.op === "messages.range") return Response.json({ result: range(body.params.fromIndex, body.params.toIndex) });
    if (body.op === "messages.since") return Response.json({ result: { resync: false, fromRevision: body.params.revision, revision: 0,
      messageCount: rows.length, rows: [], ...(historyState ? { historyState } : {}) } });
    return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
function service(fetch: typeof globalThis.fetch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cache-replay-"));
  const store = new CloudChatCacheStore(root);
  const source = new ControlPlaneCloudChatCacheSource({ baseUrl: base, fetch,
    session: async () => ({ accountId: "viewer-a", sessionId: "session-a", accessToken: "fixture-bearer" }) });
  const cache = new CloudChatCacheService({ store, source, identity: () => ({ owner, session: "session-a" }) });
  cleanup.push(() => { cache.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const lease = cache.bind(1, owner, "renderer-a");
  return { cache, store, lease };
}

describe("a chat that existed before the cache migration, with no upload since, is stored and then served", () => {
  for (const [name, rows, historyState] of [
    ["short, no historyState", chat(5), undefined],
    ["long, mid-turn window with turnOpening and senders", chat(450), { revision: 7, beforeEpoch: "3" }],
    ["long, large tool payloads", chat(260, { toolBytes: 200_000 }), { revision: 0 }],
  ] as const) it(name, async () => {
    const cp = controlPlane(rows as ReturnType<typeof chat>, historyState);
    const { cache, lease } = service(cp.fetch);
    const target = { organizationId, workspaceId, chatId: "pre-0252-chat" };
    const known = { revision: 0, messageCount: rows.length };
    const first = await cache.refresh(1, lease, target, 200, known);
    expect(first.range.rows).toHaveLength(Math.min(200, rows.length));
    expect(cache.outcomes().get("filled")).toBe(1);
    cp.calls.length = 0;
    const second = await cache.refresh(1, lease, target, 200, known);
    expect(second.cached).toBe(true);
    expect(cp.calls).toEqual([]);
  });
});
