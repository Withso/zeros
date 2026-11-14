import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeCloudChatCacheClient } from "../cloud-chat-cache-client";
import { readNativeCloudHistory } from "../cloud-chat-cache-history";
import { chatKeyFor, chatSender, clearChatSenders, keepHistorySenders } from "../chat-senders";
import { lookupChatSender, resetChatSenderLookupsForTests } from "../chat-senders-lookup";

const owner = JSON.stringify(["https://api.example.test", "viewer-a"]);
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const alice = { userId: "44444444-4444-4444-8444-444444444444" };
const prompt = { msgId: "prompt", kind: "text", payload: '{"id":"prompt","kind":"text","role":"user","text":"Hi","createdAt":1}', createdAt: 1 };
const range = { revision: 3, messageCount: 1, fromIndex: 0, toIndex: 1, rows: [{ ...prompt, index: 0 }], senders: { prompt: alice } };
afterEach(() => { clearChatSenders(); resetChatSenderLookupsForTests(); vi.useRealTimers(); });

// Master's ruling (the owner's workspaces are Team-shared): a shared chat opened from a matching cache makes zero
// requests, attribution included. Only main's cache is asked; nothing reaches the control plane.
describe("a Team-shared chat opened from a matching cache", () => {
  it("serves its senders from the cache and never asks messages.senders", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async (input: { op: string }) => input.op === "bind"
      ? { ok: true, result: { lease: "33333333-3333-4333-8333-333333333333" } }
      : { ok: true, result: { range, replaced: false, cached: true } });
    const native = new NativeCloudChatCacheClient({ invoke }); native.bindOwner(owner, "session-a");
    const network = vi.fn(async () => { throw new Error("no control-plane request expected"); });
    const read = keepHistorySenders(async (_target, op, params) =>
      (await readNativeCloudHistory(native, target, op, params, { revision: 3, messageCount: 1 })) ?? network());
    const result = await read(target, "messages.window", { chatId: "chat", limit: 200 });
    expect(result).toMatchObject({ messages: [prompt], senders: { prompt: alice } });
    expect(chatSender(chatKeyFor(target, "chat"), "prompt")).toBe(alice.userId);
    lookupChatSender(target, "chat", "prompt", network as never);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(network).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map(([input]) => input.op)).toEqual(["bind", "refresh"]);
  });
});
