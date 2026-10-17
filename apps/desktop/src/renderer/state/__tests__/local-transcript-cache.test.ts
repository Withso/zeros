import { describe, expect, it, vi } from "vitest";
import {
  LocalTranscriptCache,
  LOCAL_TRANSCRIPT_CACHE_ROWS,
  decodeLocalTranscriptWindow,
  encodeLocalTranscriptWindow,
  estimateJsonSize,
  isLocalTranscriptChat,
  type LocalTranscriptWindow,
} from "../local-transcript-cache";
import type {
  LocalTranscriptIndexEntry,
  LocalTranscriptRecord,
  LocalTranscriptStore,
} from "../../platform/local-transcript-store";
import type { AgentMessage, AgentTextMessage } from "../../features/agent/use-agent-session";

const user = (id: string): AgentTextMessage => ({ id, kind: "text", role: "user", text: `ask ${id}`, createdAt: 1 });
const agent = (id: string, text = id): AgentMessage => ({ id, kind: "text", role: "agent", text, createdAt: 1 });
const tool = (id: string, output = ""): AgentMessage => ({
  id, kind: "tool", toolCallId: id, title: `Read ${id}`, toolKind: "read", status: "completed",
  createdAt: 1, updatedAt: 1, rawOutput: output,
}) as AgentMessage;
const window = (messages: AgentMessage[], leadingPrompt: AgentTextMessage | null = null): LocalTranscriptWindow =>
  ({ messages, leadingPrompt });

class MemoryStore implements LocalTranscriptStore {
  records = new Map<string, LocalTranscriptRecord>();
  index = new Map<string, LocalTranscriptIndexEntry>();
  commits = 0;
  hold: Promise<void> | null = null;
  async readIndex() { return [...this.index.values()].map(entry => ({ ...entry })); }
  async read(chatId: string) { return this.records.get(chatId) ?? null; }
  async commit(change: Parameters<LocalTranscriptStore["commit"]>[0]) {
    if (this.hold) await this.hold;
    this.commits += 1;
    for (const id of change.remove ?? []) { this.records.delete(id); this.index.delete(id); }
    for (const { record, entry } of change.put ?? []) { this.records.set(record.chatId, record); this.index.set(entry.chatId, { ...entry }); }
    for (const entry of change.touch ?? []) this.index.set(entry.chatId, { ...entry });
  }
}

function harness(store = new MemoryStore(), options: ConstructorParameters<typeof LocalTranscriptCache>[0] = {}) {
  const scheduled: Array<() => void> = [];
  let clock = 1_000;
  const cache = new LocalTranscriptCache({
    store,
    now: () => ++clock,
    schedule: (run) => { scheduled.push(run); return () => { const at = scheduled.indexOf(run); if (at >= 0) scheduled.splice(at, 1); }; },
    ...options,
  });
  const runScheduled = async () => {
    while (scheduled.length) scheduled.shift()!();
    await cache.flush();
  };
  return { cache, store, scheduled, runScheduled };
}

describe("Local transcript cache", () => {
  it("accepts Local chats only", () => {
    expect(isLocalTranscriptChat("chat-abc", "/Users/me/repo")).toBe(true);
    expect(isLocalTranscriptChat("chat-abc", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222")).toBe(false);
    const { cache, scheduled } = harness();
    cache.remember("chat-abc", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", window([agent("a")]));
    expect(cache.peek("chat-abc")).toBeNull();
    expect(scheduled).toHaveLength(0);
  });

  it("paints a remembered window synchronously and keeps its message references", () => {
    const { cache } = harness();
    const messages = [user("u1"), agent("a1")];
    cache.remember("chat-1", "/repo", window(messages));
    const hit = cache.peek("chat-1");
    expect(hit?.messages).toBe(messages);
    expect(hit?.leadingPrompt).toBeNull();
  });

  it("writes one coalesced disk copy per changed window, never per update", async () => {
    const { cache, store, scheduled, runScheduled } = harness();
    const messages = [user("u1"), agent("a1")];
    cache.remember("chat-1", "/repo", window(messages));
    cache.remember("chat-1", "/repo", window([...messages, agent("a2")]));
    expect(scheduled).toHaveLength(1);
    await runScheduled();
    expect(store.commits).toBe(1);
    expect(decodeLocalTranscriptWindow(store.records.get("chat-1")!.json)?.messages.map(m => m.id)).toEqual(["u1", "a1", "a2"]);
    // Same content again: no rewrite.
    cache.remember("chat-1", "/repo", window([user("u1"), agent("a1"), agent("a2")]));
    await runScheduled();
    expect(store.commits).toBe(1);
  });

  it("restores a disk copy after a restart and validates it as untrusted input", async () => {
    const store = new MemoryStore();
    const first = harness(store);
    first.cache.remember("chat-1", "/repo", window([user("u1"), tool("t1", "ok")]));
    await first.runScheduled();

    const second = harness(store);
    expect(second.cache.peek("chat-1")).toBeNull();
    const restored = await second.cache.read("chat-1");
    expect(restored?.messages.map(m => m.id)).toEqual(["u1", "t1"]);
    // Now resident in memory for the next same-frame paint.
    expect(second.cache.peek("chat-1")).toBe(restored);
    // The engine confirming identical content does not rewrite the copy.
    const commit = vi.spyOn(store, "commit");
    second.cache.remember("chat-1", "/repo", window([user("u1"), tool("t1", "ok")]));
    await second.runScheduled();
    expect(commit.mock.calls.flatMap(([change]) => change.put ?? [])).toEqual([]);
    commit.mockRestore();

    store.records.set("chat-2", { chatId: "chat-2", json: "{not json" });
    store.index.set("chat-2", { chatId: "chat-2", folder: "/repo", bytes: 9, savedAt: 1, readAt: 1 });
    const third = harness(store);
    expect(await third.cache.read("chat-2")).toBeNull();
    await third.runScheduled();
    expect(store.records.has("chat-2")).toBe(false);
  });

  it("shares one disk read between concurrent callers", async () => {
    const store = new MemoryStore();
    const seed = harness(store);
    seed.cache.remember("chat-1", "/repo", window([agent("a1")]));
    await seed.runScheduled();
    const reader = harness(store);
    const spy = vi.spyOn(store, "read");
    const [a, b] = await Promise.all([reader.cache.read("chat-1"), reader.cache.read("chat-1")]);
    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never resurrects a forgotten transcript from an in-flight write", async () => {
    const store = new MemoryStore();
    const { cache, runScheduled } = harness(store);
    cache.remember("chat-1", "/repo", window([agent("a1")]));
    let release!: () => void;
    store.hold = new Promise<void>(resolve => { release = resolve; });
    const flushing = runScheduled();
    cache.forget("chat-1");
    release();
    await flushing;
    await cache.flush();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.records.has("chat-1")).toBe(false);
    expect(await harness(store).cache.read("chat-1")).toBeNull();
  });

  it("removes every cached copy of a confirmed empty transcript without clearing another chat", async () => {
    const { cache, store, runScheduled } = harness();
    cache.remember("chat-1", "/repo", window([user("u1"), agent("a1")]));
    cache.remember("chat-2", "/organization/repo", window([user("u2"), agent("a2")]));
    await runScheduled();
    const commit = store.commit.bind(store);
    let removed!: () => void;
    const deletion = new Promise<void>(resolve => { removed = resolve; });
    vi.spyOn(store, "commit").mockImplementation(async change => {
      await commit(change);
      if (change.remove?.includes("chat-1")) removed();
    });

    cache.remember("chat-1", "/repo", window([]));
    expect(cache.peek("chat-1")).toBeNull();
    expect(cache.peek("chat-2")?.messages[0].id).toBe("u2");
    await deletion;
    expect(store.records.has("chat-1")).toBe(false);
    expect(store.index.has("chat-1")).toBe(false);
    const restarted = harness(store).cache;
    expect(await restarted.read("chat-1")).toBeNull();
    expect((await restarted.read("chat-2"))?.messages[0].id).toBe("u2");
  });

  it("prunes chats and owners that no longer exist", async () => {
    const store = new MemoryStore();
    const { cache, runScheduled } = harness(store);
    cache.remember("chat-keep", "/repo/a", window([agent("a")]));
    cache.remember("chat-gone", "/repo/b", window([agent("b")]));
    await runScheduled();
    cache.retain((chatId) => chatId === "chat-keep");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cache.peek("chat-gone")).toBeNull();
    expect(store.records.has("chat-gone")).toBe(false);
    expect(store.records.has("chat-keep")).toBe(true);
  });

  it("bounds memory by entries and bytes, oldest first", () => {
    const { cache } = harness(new MemoryStore(), { memoryEntries: 2, memoryBytes: 10_000 });
    cache.remember("chat-1", "/repo", window([agent("a1")]));
    cache.remember("chat-2", "/repo", window([agent("a2")]));
    cache.peek("chat-1");
    cache.remember("chat-3", "/repo", window([agent("a3")]));
    expect(cache.peek("chat-2")).toBeNull();
    expect(cache.peek("chat-1")).not.toBeNull();
    cache.remember("chat-big", "/repo", window([agent("x", "y".repeat(20_000))]));
    expect(cache.peek("chat-big")).toBeNull();
    expect(cache.memoryStats().bytes).toBeLessThanOrEqual(10_000);
  });

  it("bounds the disk tier, evicting the least recently read chat", async () => {
    const store = new MemoryStore();
    const { cache, runScheduled } = harness(store, { diskEntries: 2 });
    cache.remember("chat-1", "/repo", window([agent("a1")]));
    await runScheduled();
    cache.remember("chat-2", "/repo", window([agent("a2")]));
    await runScheduled();
    cache.remember("chat-3", "/repo", window([agent("a3")]));
    await runScheduled();
    expect([...store.records.keys()].sort()).toEqual(["chat-2", "chat-3"]);
  });

  it("stores the newest rows within budget and keeps the opening prompt at the cut", () => {
    const messages = [user("u0"), agent("a0"), user("u1"), ...Array.from({ length: 300 }, (_, i) => tool(`t${i}`))];
    const encoded = encodeLocalTranscriptWindow(window(messages))!;
    const decoded = decodeLocalTranscriptWindow(encoded.json)!;
    expect(decoded.messages).toHaveLength(LOCAL_TRANSCRIPT_CACHE_ROWS);
    expect(decoded.messages.at(-1)?.id).toBe("t299");
    expect(decoded.leadingPrompt?.id).toBe("u1");

    const small = encodeLocalTranscriptWindow(window(messages), 4_000)!;
    const smallDecoded = decodeLocalTranscriptWindow(small.json)!;
    expect(small.bytes).toBeLessThanOrEqual(4_000);
    expect(smallDecoded.messages.at(-1)?.id).toBe("t299");
    expect(smallDecoded.leadingPrompt?.id).toBe("u1");
  });

  it("keeps a giant tool row's structure but not its megabytes", () => {
    const huge = tool("t-huge", "z".repeat(2 * 1024 * 1024));
    const encoded = encodeLocalTranscriptWindow(window([user("u1"), huge]))!;
    expect(encoded.bytes).toBeLessThan(64 * 1024);
    const decoded = decodeLocalTranscriptWindow(encoded.json)!;
    expect(decoded.messages[1]).toMatchObject({ id: "t-huge", kind: "tool", title: "Read t-huge", status: "completed" });
    expect(estimateJsonSize(huge, 1_000)).toBeGreaterThan(1_000);
  });
});
