import { describe, expect, it, vi } from "vitest";
import { NativeCloudChatCacheClient } from "../cloud-chat-cache-client";
import { readNativeCloudHistory } from "../cloud-chat-cache-history";

const owner = JSON.stringify(["https://api.example.test", "viewer-a"]);
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const row = { msgId: "row", kind: "text", payload: '{"id":"row","kind":"text","role":"user","text":"Saved","createdAt":1}', createdAt: 1 };
const range = { revision: 12, messageCount: 1, fromIndex: 0, toIndex: 1, rows: [{ ...row, index: 0 }] };
function fixture(failure?: string, cached = false) {
  const invoke = vi.fn(async (input: { op: string }) => {
    if (input.op === "bind") return { ok: true, result: { lease: "33333333-3333-4333-8333-333333333333" } };
    if (input.op === "release") return { ok: true, result: null };
    if (failure) return { ok: false, reason: failure };
    return { ok: true, result: input.op === "refresh" ? { range, replaced: false, ...(cached ? { cached: true } : {}) } : input.op === "refresh-before" ? range : null };
  });
  const native = new NativeCloudChatCacheClient({ invoke }); native.bindOwner(owner, "session-a");
  return { native, invoke };
}

describe("passive native history integration", () => {
  it("serves a server-confirmed native range without changing its payload or using an offline read", async () => {
    const { native, invoke } = fixture();
    expect(await readNativeCloudHistory(native, target, "messages.window", { chatId: "chat", limit: 200 })).toEqual({ messages: [row] });
    expect(invoke.mock.calls.map(([input]) => input.op)).toContain("refresh");
    expect(invoke.mock.calls.map(([input]) => input.op)).not.toContain("read");
  });
  it("forwards the chats.list revision; an unchanged chat answers from the cache without a receipts read", async () => {
    for (const cached of [false, true]) {
      const { native, invoke } = fixture(undefined, cached), known = { revision: 12, messageCount: 1 };
      // The receipts refresh is started before the read returns, or not at all: no timer is needed to observe it.
      const pending = vi.spyOn(native, "refreshPending");
      expect(await readNativeCloudHistory(native, target, "messages.window", { chatId: "chat", limit: 200 }, known)).toEqual({ messages: [row] });
      expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ op: "refresh", known }));
      expect(pending).toHaveBeenCalledTimes(cached ? 0 : 1);
    }
  });
  it("caches older live pages only through the revision-checked refresh-before boundary", async () => {
    const { native, invoke } = fixture();
    expect(await readNativeCloudHistory(native, target, "messages.windowOlder", { chatId: "chat", limit: 200, beforeMsgId: "later" })).toEqual({ messages: [row] });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ op: "refresh-before", before: "later", target: { ...target, chatId: "chat" } }));
  });
  it.each(["unsupported", "unavailable"])("falls back to the existing reader on %s without calling cached rows authoritative", async failure => {
    const { native, invoke } = fixture(failure);
    expect(await readNativeCloudHistory(native, target, "messages.window", { chatId: "chat", limit: 200 })).toBeNull();
    expect(invoke.mock.calls.map(([input]) => input.op)).not.toContain("read");
  });
  it.each(["access_lost", "owner_changed"])("does not turn %s into another account's history request", async failure => {
    const { native } = fixture(failure);
    await expect(readNativeCloudHistory(native, target, "messages.window", { chatId: "chat", limit: 200 })).rejects.toMatchObject({ reason: failure });
  });
  it("leaves searches, timestamp windows, large windows and unsigned readers on their existing path", async () => {
    const { native, invoke } = fixture();
    for (const [op, params] of [["chats.list", {}], ["messages.search", { query: "x" }],
      ["messages.window", { chatId: "chat", limit: 200, before: 7 }], ["messages.window", { chatId: "chat", limit: 1000 }]] as const)
      expect(await readNativeCloudHistory(native, target, op, params)).toBeNull();
    native.bindOwner(null);
    expect(await readNativeCloudHistory(native, target, "messages.window", { chatId: "chat", limit: 200 })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("reads the renderer answers without main are reported to main.log, by closed class", () => {
  it("batches one report per burst: no owner, a failed refresh, an uncached older page", async () => {
    vi.useFakeTimers();
    try {
      const failing = fixture("unavailable");
      const reports = () => failing.invoke.mock.calls.map(([input]) => input).filter(input => input.op === "report");
      expect(await readNativeCloudHistory(failing.native, target, "messages.window", { chatId: "chat", limit: 200 })).toBeNull();
      expect(await readNativeCloudHistory(failing.native, target, "messages.window", { chatId: "chat", limit: 200 })).toBeNull();
      expect(await readNativeCloudHistory(failing.native, target, "messages.windowOlder", { chatId: "chat", limit: 200 })).toBeNull();
      expect(reports()).toEqual([]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reports()).toEqual([{ op: "report", declines: { fallback_unavailable: 2, older_cursor: 1 } }]);
      const unboundInvoke = vi.fn(async () => ({ ok: true, result: null }));
      const silent = new NativeCloudChatCacheClient({ invoke: unboundInvoke });
      expect(await readNativeCloudHistory(silent, target, "messages.window", { chatId: "chat", limit: 200 })).toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(unboundInvoke.mock.calls).toEqual([[{ op: "report", declines: { no_owner: 1 } }]]);
    } finally { vi.useRealTimers(); }
  });
});
