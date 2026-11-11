import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { acceptChatSenders, chatKeyFor, chatSender, clearChatSenders, keepHistorySenders } from "../chat-senders";
import { lookupChatSender, resetChatSenderLookupsForTests } from "../chat-senders-lookup";

const alex = "44444444-4444-4444-8444-444444444444";
beforeEach(() => { clearChatSenders(); resetChatSenderLookupsForTests(); });
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };

describe("chat senders (team sharing phase 2, slice A)", () => {
  it("keeps who sent each user message per chat, a known-unknown null, and ignores malformed entries", () => {
    acceptChatSenders("chat-a", { m1: { userId: alex, extra: 1 }, m2: null, m3: { userId: "nope" }, m4: "x" });
    expect([chatSender("chat-a", "m1"), chatSender("chat-a", "m2"), chatSender("chat-a", "m3"), chatSender("chat-a", "m4")]).toEqual([alex, null, undefined, undefined]);
    expect(chatSender("chat-b", "m1")).toBeUndefined();
    acceptChatSenders("chat-a", ["not", "a", "map"]);
    expect(chatSender("chat-a", "m1")).toBe(alex);
    clearChatSenders();
    expect(chatSender("chat-a", "m1")).toBeUndefined();
  });

  it("stays bounded: 2,000 messages per chat and 64 chats, oldest first", () => {
    acceptChatSenders("chat-a", Object.fromEntries(Array.from({ length: 2_100 }, (_, index) => [`m${index}`, { userId: alex }])));
    expect(chatSender("chat-a", "m0")).toBeUndefined();
    expect(chatSender("chat-a", "m2099")).toBe(alex);
    for (let index = 0; index < 70; index++) acceptChatSenders(`chat-${index}`, { m: { userId: alex } });
    expect(chatSender("chat-0", "m")).toBeUndefined();
    expect(chatSender("chat-69", "m")).toBe(alex);
  });

  it("keeps a history reply's sender map for the chat it was read for, and passes the reply through", async () => {
    const read = keepHistorySenders(async () => ({ messages: [], senders: { "msg-1": { userId: alex } } }));
    expect(await read(target, "messages.window", { chatId: "chat-7", limit: 100 })).toMatchObject({ messages: [] });
    expect(chatSender(chatKeyFor(target, "chat-7"), "msg-1")).toBe(alex);
    expect(chatSender(chatKeyFor(target, "chat-8"), "msg-1")).toBeUndefined();
  });

  it("asks messages.senders for unattributed messages in one batch per chat, each id once, at most 200 per request", async () => {
    vi.useFakeTimers();
    try {
      const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
      const read = vi.fn(async (_target: unknown, op: string, params: Record<string, unknown>) => {
        calls.push({ op, params });
        return { senders: Object.fromEntries((params.userMessageIds as string[]).map(id => [id, id === "m0" ? { userId: alex } : null])) };
      });
      for (let index = 0; index < 250; index++) lookupChatSender(target, "chat-7", `m${index}`, read as never);
      lookupChatSender(target, "chat-7", "m0", read as never);   // asked already
      lookupChatSender(target, "chat-7", "x".repeat(257), read as never);   // not an id
      await vi.advanceTimersByTimeAsync(200);
      expect(calls.map(call => [call.op, call.params.chatId, (call.params.userMessageIds as string[]).length])).toEqual([["messages.senders", "chat-7", 200], ["messages.senders", "chat-7", 50]]);
      expect(chatSender(chatKeyFor(target, "chat-7"), "m0")).toBe(alex);
      expect(chatSender(chatKeyFor(target, "chat-7"), "m1")).toBeNull();
      lookupChatSender(target, "chat-7", "m1", read as never);
      await vi.advanceTimersByTimeAsync(200);
      expect(calls).toHaveLength(2);   // answered (null): never asked again
    } finally { vi.useRealTimers(); }
  });
});
