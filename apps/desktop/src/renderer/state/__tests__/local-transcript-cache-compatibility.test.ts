import { describe, expect, it, vi } from "vitest";
import {
  LocalTranscriptCache,
  LOCAL_TRANSCRIPT_DISK_BYTES,
  LOCAL_TRANSCRIPT_DISK_ENTRIES,
  LOCAL_TRANSCRIPT_ENTRY_BYTES,
  LOCAL_TRANSCRIPT_MEMORY_BYTES,
  LOCAL_TRANSCRIPT_MEMORY_ENTRIES,
  decodeLocalTranscriptWindow,
  encodeLocalTranscriptWindow,
  estimateJsonSize,
  localTranscriptCache,
  type LocalTranscriptWindow,
} from "../local-transcript-cache";
import type {
  LocalTranscriptIndexEntry,
  LocalTranscriptRecord,
  LocalTranscriptStore,
} from "../../platform/local-transcript-store";
import type { AgentMessage } from "../../features/agent/use-agent-session";
import { rememberLocalTranscript } from "../../features/agent/local-transcript-presentation";
import { BLANK } from "../../features/agent/sessions-store";

const row = (id: string, text = id): AgentMessage => ({ id, kind: "text", role: "agent", text, createdAt: 1 });
const window = (text = "answer"): LocalTranscriptWindow => ({ messages: [row("answer", text)], leadingPrompt: null });

class Store implements LocalTranscriptStore {
  records = new Map<string, LocalTranscriptRecord>();
  index = new Map<string, LocalTranscriptIndexEntry>();
  async readIndex() { return [...this.index.values()].map(entry => ({ ...entry })); }
  async read(chatId: string) { return this.records.get(chatId) ?? null; }
  async commit(change: Parameters<LocalTranscriptStore["commit"]>[0]) {
    for (const id of change.remove ?? []) { this.records.delete(id); this.index.delete(id); }
    for (const { record, entry } of change.put ?? []) { this.records.set(record.chatId, record); this.index.set(entry.chatId, { ...entry }); }
    for (const entry of change.touch ?? []) this.index.set(entry.chatId, { ...entry });
  }
}

function cache(store = new Store(), options: ConstructorParameters<typeof LocalTranscriptCache>[0] = {}) {
  let clock = 0;
  return new LocalTranscriptCache({ store, schedule: () => () => {}, now: () => ++clock, ...options });
}

describe("Local transcript cache compatibility", () => {
  it("preserves the original Local budgets independently of cloud", async () => {
    expect.soft(LOCAL_TRANSCRIPT_MEMORY_BYTES).toBe(16 * 1024 * 1024);
    expect.soft(LOCAL_TRANSCRIPT_DISK_BYTES).toBe(40 * 1024 * 1024);
    expect.soft(LOCAL_TRANSCRIPT_MEMORY_ENTRIES).toBe(16);
    expect.soft(LOCAL_TRANSCRIPT_DISK_ENTRIES).toBe(96);
    const store = new Store(), local = cache(store);
    for (let index = 0; index < 97; index++) {
      local.remember(`chat-${index}`, index % 2 ? "/organization/repo" : "/personal/repo", window());
      await local.flush();
    }
    expect.soft(local.memoryStats().entries).toBe(16);
    expect.soft([...store.records.keys()]).toEqual(Array.from({ length: 96 }, (_, index) => `chat-${index + 1}`));
  });

  it("keeps the original character accounting and full per-chat window", async () => {
    const messages = Array.from({ length: 200 }, (_, index) => row(`row-${index}`, "é".repeat(3_000)));
    const transcript = { messages, leadingPrompt: null };
    const encoded = encodeLocalTranscriptWindow(transcript)!;
    expect.soft(encoded.kept).toBe(200);
    expect.soft(encoded.bytes).toBe(encoded.json.length);
    const store = new Store(), local = cache(store, { memoryBytes: 700_000 });
    local.remember("chat", "/repo", transcript);
    expect.soft(local.peek("chat")?.messages === messages).toBe(true);
    expect.soft(local.memoryStats().bytes).toBe(estimateJsonSize(messages));
    await local.flush();
    expect.soft(store.index.get("chat")?.bytes).toBe(encoded.json.length);
    expect.soft(store.index.get("chat")).not.toHaveProperty("bytesEncoding");
    expect.soft(store.records.get("chat")?.json === JSON.stringify({ version: 1, ...transcript })).toBe(true);
  });

  it("preserves the original estimate when JSON escaping expands a Local record", () => {
    const messages = Array.from({ length: 40 }, (_, index) => row(`row-${index}`, "\n".repeat(15_000)));
    const encoded = encodeLocalTranscriptWindow({ messages, leadingPrompt: null })!;
    expect.soft(encoded.kept).toBe(40);
    expect.soft(encoded.bytes).toBe(encoded.json.length);
    expect.soft(encoded.json.length).toBeGreaterThan(LOCAL_TRANSCRIPT_ENTRY_BYTES);
    const decoded = decodeLocalTranscriptWindow(encoded.json);
    expect(decoded?.messages.map(message => message.id)).toEqual(messages.map(message => message.id));
    expect(decoded?.messages.every(message => message.kind === "text" && message.text === "\n".repeat(15_000))).toBe(true);
  });

  it("leaves Local disk metadata untouched until an actual read or write", async () => {
    const store = new Store();
    const json = JSON.stringify({ version: 1, ...window() });
    for (const index of [1, 2, 3]) {
      const chatId = `chat-${index}`;
      store.records.set(chatId, { chatId, json });
      store.index.set(chatId, { chatId, folder: "/repo", bytes: json.length, savedAt: index, readAt: index });
    }
    const readIndex = vi.spyOn(store, "readIndex"), commit = vi.spyOn(store, "commit");
    const local = cache(store, { diskEntries: 2 });
    await local.flush();
    expect.soft(readIndex).not.toHaveBeenCalled();
    expect.soft(commit).not.toHaveBeenCalled();
    expect.soft([...store.index.values()].map(entry => entry.bytes)).toEqual([json.length, json.length, json.length]);
    expect.soft(store.records.size).toBe(3);
  });

  it("uses the persisted character count for a restored memory entry", async () => {
    const store = new Store(), json = JSON.stringify({ version: 1, ...window() });
    store.records.set("chat", { chatId: "chat", json });
    store.index.set("chat", { chatId: "chat", folder: "/repo", bytes: json.length, savedAt: 1, readAt: 1 });
    const local = cache(store);
    expect(await local.read("chat")).toEqual(window());
    expect(local.memoryStats()).toEqual({ entries: 1, bytes: json.length });
  });

  it("persists pending captures after memory eviction and release", async () => {
    const store = new Store(), local = cache(store, { memoryEntries: 1 });
    local.remember("personal", "/personal/repo", window("personal"));
    local.remember("organization", "/organization/repo", window("organization"));
    expect(local.peek("personal")).toBeNull();
    local.releaseMemory();
    await local.flush();
    const restarted = cache(store);
    expect.soft(await restarted.read("personal")).toEqual(window("personal"));
    expect.soft(await restarted.read("organization")).toEqual(window("organization"));
  });

  it("keeps an admitted Local write while the disk index and memory release overlap", async () => {
    const store = new Store();
    let release!: (entries: LocalTranscriptIndexEntry[]) => void, started!: () => void;
    const held = new Promise<LocalTranscriptIndexEntry[]>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(store, "readIndex").mockImplementationOnce(() => { started(); return held; });
    const local = cache(store, { memoryEntries: 1 });
    local.remember("old", "/repo", window("old"));
    const pending = local.flush();
    await reading;
    local.releaseMemory();
    local.remember("new", "/repo", window("new"));
    release([]);
    await pending;
    await local.flush();
    expect([...store.records.keys()]).toEqual(["old", "new"]);
    expect(local.memoryStats().entries).toBe(1);
  });

  it("still writes a disk copy when its live window exceeds the memory allowance", async () => {
    const store = new Store(), local = cache(store, { memoryBytes: 100 });
    local.remember("chat", "/repo", window("text".repeat(100)));
    expect(local.peek("chat")).toBeNull();
    await local.flush();
    expect(await cache(store).read("chat")).toEqual(window("text".repeat(100)));
  });

  it.each([
    { id: "legacy", kind: "legacy-progress", createdAt: 1 },
    { id: "tool", kind: "tool", title: "Read", createdAt: 1 },
    { ...row("text"), updatedAt: "legacy-stamp" },
  ])("keeps the lenient Local row decoder for %j", message => {
    const json = JSON.stringify({ version: 1, messages: [message], leadingPrompt: { id: "invalid" } });
    expect(decodeLocalTranscriptWindow(json)).toEqual({ messages: [message], leadingPrompt: null });
  });

  it("does not schedule another write when Local confirmation has the same signature", async () => {
    const schedule = vi.fn(() => () => {}), local = cache(new Store(), { schedule });
    local.remember("chat", "/repo", window());
    await local.flush();
    schedule.mockClear();
    local.remember("chat", "/repo", window());
    expect(schedule).not.toHaveBeenCalled();
  });

  it.each(["/personal/repo", "/organization/repo"])("captures the original Local window without cloud prompt filtering in %s", folder => {
    const messages: AgentMessage[] = [row("answer"), { id: "queued", kind: "text", role: "user", text: "next", queued: true, createdAt: 2 }];
    try {
      rememberLocalTranscript("local", { ...BLANK, cwd: folder, transcriptState: "resident", messages }, folder);
      expect(localTranscriptCache.peek("local")?.messages === messages).toBe(true);
    } finally {
      localTranscriptCache.resetForTesting();
    }
  });
});
