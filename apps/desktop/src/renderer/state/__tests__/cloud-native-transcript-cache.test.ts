import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalTranscriptCache, type LocalTranscriptWindow } from "../local-transcript-cache";
import { createNativeCloudTranscriptCache } from "../cloud-native-transcript-cache";
import { NativeCloudChatCacheClient, type NativeCloudCacheSnapshot } from "../../platform/cloud-chat-cache-client";
import type { CloudCacheRequest } from "../../../../shared/cloud-chat-cache";
import { chatKeyFor, chatSender, clearChatSenders } from "../../platform/chat-senders";

const owner = JSON.stringify(["https://api.example.test", "viewer-a"]);
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "chat" };
const chatId = `cloud:${target.organizationId}:${target.workspaceId}:chat`, folder = `cloud://${target.organizationId}/${target.workspaceId}`;
const lease = "33333333-3333-4333-8333-333333333333";
const message = { id: "message", kind: "text" as const, role: "user" as const, text: "Saved native prompt", createdAt: 1 };
const page = { revision: 6, messageCount: 1, fromIndex: 0, toIndex: 1, rows: [{ index: 0, msgId: "message", kind: "text", payload: JSON.stringify(message), createdAt: 1 }] };
const ok = (result: unknown) => ({ ok: true, result });
const caches: Array<LocalTranscriptCache> = [];
afterEach(() => { for (const cache of caches.splice(0)) cache.resetForTesting(); });
function fixture(known?: (chatId: string) => Promise<{ revision: number; messageCount: number } | undefined>) {
  const invoke = vi.fn(async (input: CloudCacheRequest): Promise<unknown> => {
    if (input.op === "bind") return ok({ lease });
    if (input.op === "read") return ok({ range: page, pending: null });
    return { ok: false, reason: "unavailable" };
  });
  const native = new NativeCloudChatCacheClient({ invoke });
  const decode = (snapshot: NativeCloudCacheSnapshot, owner: string, epoch: number): LocalTranscriptWindow | null => snapshot.range ? {
    messages: snapshot.range.rows.map(row => JSON.parse(row.payload)), leadingPrompt: null, source: "control-plane",
    cloudCache: { owner, epoch, revision: snapshot.range.revision },
  } : null;
  const cache = createNativeCloudTranscriptCache(LocalTranscriptCache, native, decode, known);
  cache.bindOwner(owner, false); caches.push(cache);
  return { cache, native, invoke };
}

describe("cloud native disk and renderer memory tiers", () => {
  it("a painted cached transcript publishes its stored senders", async () => {
    const f = fixture();
    const alice = { userId: "44444444-4444-4444-8444-444444444444" };
    f.invoke.mockImplementation(async input => input.op === "bind" ? ok({ lease }) :
      input.op === "read" ? ok({ range: { ...page, senders: { message: alice } }, pending: null }) : { ok: false, reason: "unavailable" });
    await f.cache.read(chatId);
    expect(chatSender(chatKeyFor(target, "chat"), "message")).toBe(alice.userId);
    clearChatSenders();
  });
  it("revalidates an unchanged chat with its chats.list revision and no receipts read", async () => {
    for (const cached of [true, false]) {
      const f = fixture(async id => id === chatId ? { revision: 6, messageCount: 1 } : undefined);
      f.invoke.mockImplementation(async input => input.op === "bind" ? ok({ lease }) : input.op === "read" ? ok({ range: page, pending: null }) :
        input.op === "refresh" ? ok({ range: page, replaced: false, ...(cached ? { cached: true } : {}) }) : ok(null));
      await f.cache.read(chatId);
      await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ op: "refresh", known: { revision: 6, messageCount: 1 } })));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(f.invoke.mock.calls.some(([input]) => input.op === "refresh-pending")).toBe(!cached);
      f.cache.resetForTesting();
    }
  });
  it("paints a native cached tail while its passive refresh is still held", async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    const held = new Promise<unknown>(resolve => { release = resolve; });
    f.invoke.mockImplementation(async input => input.op === "bind" ? ok({ lease }) :
      input.op === "read" ? ok({ range: page, pending: null }) : held);
    try {
      const cached = await f.cache.read(chatId);
      expect(cached?.messages).toEqual([message]);
      expect(cached?.cloudCache).toEqual({ owner, epoch: f.native.epoch, revision: 6 });
      expect(f.cache.peek(chatId)).toBe(cached);
      expect(f.invoke.mock.calls.some(([call]) => call.op === "refresh")).toBe(true);
    } finally { release({ ok: false, reason: "unavailable" }); }
  });

  it("keeps a newer live memory window when an older disk reply arrives", async () => {
    const f = fixture();
    let release!: (value: unknown) => void, start!: () => void;
    const ready = new Promise<void>(resolve => { start = resolve; });
    const held = new Promise<unknown>(resolve => { release = resolve; });
    f.invoke.mockImplementation(async input => {
      if (input.op === "bind") return ok({ lease });
      if (input.op === "read") { start(); return held; }
      return { ok: false, reason: "unavailable" };
    });
    const read = f.cache.read(chatId);
    await vi.waitFor(() => expect(f.invoke.mock.calls.some(([call]) => call.op === "read")).toBe(true));
    await ready;
    f.cache.remember(chatId, folder, { messages: [{ ...message, text: "Live worker content" }], leadingPrompt: null, source: "worker" });
    const live = f.cache.peek(chatId);
    release(ok({ range: page, pending: null }));
    expect(await read).toBe(live);
  });

  it("refreshes native storage when a confirmed worker window is remembered", async () => {
    const f = fixture();
    f.cache.remember(chatId, folder, { messages: [message], leadingPrompt: null, source: "worker" });
    await vi.waitFor(() => expect(f.invoke.mock.calls.some(([call]) => call.op === "refresh")).toBe(true));
    expect(f.cache.peek(chatId)?.messages).toEqual([message]);
    expect(f.invoke.mock.calls.find(([call]) => call.op === "refresh")?.[0]).toEqual({ op: "refresh", lease, target, limit: 200 });
  });

  it("revalidates a worker settlement that arrives during an older cache refresh", async () => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    const held = new Promise<unknown>(resolve => { finish = resolve; });
    f.invoke.mockImplementation(async input => input.op === "bind" ? ok({ lease }) :
      input.op === "read" ? ok({ range: page, pending: null }) : input.op === "refresh" ? held : ok(null));
    await f.cache.read(chatId);
    await vi.waitFor(() => expect(f.invoke.mock.calls.filter(([call]) => call.op === "refresh")).toHaveLength(1));
    f.cache.remember(chatId, folder, { messages: [{ ...message, text: "Final worker result" }], leadingPrompt: null, source: "worker" });
    finish(ok({ range: page, replaced: false }));
    await vi.waitFor(() => expect(f.invoke.mock.calls.filter(([call]) => call.op === "refresh")).toHaveLength(2));
    expect(f.cache.peek(chatId)?.messages[0]).toMatchObject({ text: "Final worker result" });
  });

  it("prunes a native disk chat even when no renderer memory entry exists", async () => {
    const f = fixture();
    f.invoke.mockImplementation(async input => input.op === "bind" ? ok({ lease }) : input.op === "list"
      ? ok({ items: [target], nextAfter: null }) : ok(null));
    expect(f.cache.memoryStats().entries).toBe(0);
    f.cache.retain(() => false);
    await vi.waitFor(() => expect(f.invoke.mock.calls.some(([call]) => call.op === "forget")).toBe(true));
    expect(f.invoke.mock.calls.find(([call]) => call.op === "forget")?.[0]).toMatchObject({ targets: [target] });
  });

  it("charges cached receipt presentation to the existing cloud memory limit", () => {
    const f = fixture();
    f.cache.remember(chatId, folder, { messages: [message], leadingPrompt: null, source: "control-plane",
      cloudCache: { owner, epoch: f.native.epoch, revision: 6, receiptRows: [{ ...message, id: "receipt", text: "x".repeat(9 * 1024 * 1024) }] } });
    expect(f.cache.peek(chatId)).toBeNull();
    expect(f.cache.memoryStats()).toEqual({ entries: 0, bytes: 0 });
  });

  it("leaves Local Personal and organization-local caching on their existing store", async () => {
    const f = fixture();
    expect(await f.cache.read("local-chat")).toBeNull();
    expect(f.invoke).not.toHaveBeenCalled();
    for (const folder of ["/fixture/personal", "/fixture/organization"]) {
      const local = new LocalTranscriptCache({ store: null }); caches.push(local);
      local.remember("local-chat", folder, { messages: [message], leadingPrompt: null });
      expect((await local.read("local-chat"))?.messages).toEqual([message]);
    }
  });
});
