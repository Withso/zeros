import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalTranscriptCache, cloudTranscriptCache, decodeCloudTranscriptWindow, LOCAL_TRANSCRIPT_ENTRY_BYTES } from "../local-transcript-cache";
import { cloudScopedId, cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { accountPresentationOwner } from "../../platform/account-presentation-cache";
import type { LocalTranscriptIndexEntry, LocalTranscriptRecord, LocalTranscriptStore } from "../../platform/local-transcript-store";
import type { AgentMessage } from "../../features/agent/use-agent-session";

const a = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const b = { ...a, organizationId: "33333333-3333-4333-8333-333333333333" };
const c = { ...a, workspaceId: "44444444-4444-4444-8444-444444444444" };
const ownerA = accountPresentationOwner("https://api.example.test", "account-a");
const ownerB = accountPresentationOwner("https://api.example.test", "account-b");
const row = (id: string, text = id): AgentMessage => ({ id, kind: "text", role: "agent", text, createdAt: 1 });
const window = (text: string) => ({ messages: [row("answer", text)], leadingPrompt: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class Store implements LocalTranscriptStore {
  records = new Map<string, LocalTranscriptRecord>();
  index = new Map<string, LocalTranscriptIndexEntry>();
  async readIndex() { return [...this.index.values()].map(entry => ({ ...entry })); }
  async read(key: string) { return this.records.get(key) ?? null; }
  async commit(change: Parameters<LocalTranscriptStore["commit"]>[0]) {
    if (change.clear) { this.records.clear(); this.index.clear(); }
    for (const key of change.remove ?? []) { this.records.delete(key); this.index.delete(key); }
    for (const { record, entry } of change.put ?? []) { this.records.set(record.chatId, record); this.index.set(entry.chatId, { ...entry }); }
    for (const entry of change.touch ?? []) this.index.set(entry.chatId, { ...entry });
  }
}
function cache(store: LocalTranscriptStore | null = new Store(), owner = ownerA, options: ConstructorParameters<typeof LocalTranscriptCache>[0] = {}) {
  return new LocalTranscriptCache({ namespace: "cloud", owner, store, schedule: () => () => {},
    memoryEntries: 8, memoryBytes: 8 * 1024 * 1024, diskEntries: 48, diskBytes: 20 * 1024 * 1024, ...options });
}
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});
afterEach(() => { cloudTranscriptCache.resetForTesting(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("cloud transcript storage", () => {
  it("gives cloud its own eight memory windows without evicting Local windows", () => {
    const local = new LocalTranscriptCache({ store: null, schedule: () => () => {} });
    cloudTranscriptCache.bindOwner(ownerA, false);
    for (let index = 0; index < 16; index++) {
      local.remember(`local-${index}`, "/repo", window("local"));
      cloudTranscriptCache.remember(cloudScopedId(a, `cloud-${index}`), cloudWorkspaceKey(a), window("cloud"));
    }
    expect(local.memoryStats().entries).toBe(16);
    expect(cloudTranscriptCache.memoryStats().entries).toBe(8);
    expect(cloudTranscriptCache.peek(cloudScopedId(a, "cloud-7"))).toBeNull();
    expect(cloudTranscriptCache.peek(cloudScopedId(a, "cloud-8"))).not.toBeNull();
  });

  it("uses Local's character units for the cloud per-window budget", async () => {
    const store = new Store(), transcript = cache(store), id = cloudScopedId(a, "chat");
    const messages = Array.from({ length: 200 }, (_, index) => row(`row-${index}`, "é".repeat(3_000)));
    transcript.remember(id, cloudWorkspaceKey(a), { messages, leadingPrompt: null, source: "worker" });
    await transcript.flush();
    const record = [...store.records.values()][0], entry = [...store.index.values()][0];
    expect(entry.bytes).toBe(record.json.length);
    expect(entry).not.toHaveProperty("bytesEncoding");
    expect(decodeCloudTranscriptWindow(record.json)?.messages).toHaveLength(200);
  });

  it("bounds cloud pending captures when memory evicts a window", async () => {
    const store = new Store(), transcript = cache(store, ownerA, { memoryEntries: 1 });
    const old = cloudScopedId(a, "old"), next = cloudScopedId(a, "next");
    transcript.remember(old, cloudWorkspaceKey(a), window("old"));
    transcript.remember(next, cloudWorkspaceKey(a), window("next"));
    await transcript.flush();
    const restarted = cache(store);
    expect(await restarted.read(old)).toBeNull();
    expect(await restarted.read(next)).toEqual(window("next"));
  });

  it("releases cloud pending payloads even while the disk index is held", async () => {
    const store = new Store(), held = deferred<LocalTranscriptIndexEntry[]>(), started = deferred<void>();
    vi.spyOn(store, "readIndex").mockImplementationOnce(() => { started.resolve(); return held.promise; });
    const transcript = cache(store, ownerA, { memoryEntries: 1 });
    const old = cloudScopedId(a, "old"), next = cloudScopedId(a, "next");
    transcript.remember(old, cloudWorkspaceKey(a), window("old"));
    const pending = transcript.flush();
    await started.promise;
    transcript.releaseMemory();
    transcript.remember(next, cloudWorkspaceKey(a), window("next"));
    held.resolve([]);
    await pending;
    await transcript.flush();
    const restarted = cache(store);
    expect(await restarted.read(old)).toBeNull();
    expect(await restarted.read(next)).toEqual(window("next"));
  });

  it("removes an older disk copy when a replacement exceeds cloud's memory allowance", async () => {
    const store = new Store(), transcript = cache(store, ownerA, { memoryBytes: 1_000 }), id = cloudScopedId(a, "chat");
    transcript.remember(id, cloudWorkspaceKey(a), window("old"));
    await transcript.flush();
    transcript.remember(id, cloudWorkspaceKey(a), window("large".repeat(1_000)));
    await transcript.flush();
    expect(transcript.peek(id)).toBeNull();
    expect(await cache(store).read(id)).toBeNull();
    expect(store.records.size).toBe(0);
    transcript.remember(id, cloudWorkspaceKey(a), window("old"));
    await transcript.flush();
    expect(await cache(store).read(id)).toEqual(window("old"));
  });

  it("removes an older disk copy when a replacement cannot fit its encoded cloud window", async () => {
    const store = new Store(), transcript = cache(store), id = cloudScopedId(a, "chat");
    transcript.remember(id, cloudWorkspaceKey(a), window("old"));
    await transcript.flush();
    const message = { ...row("answer"), attachments: Array.from({ length: 1_000 }, () => ({
      kind: "file" as const, name: "name".repeat(250), mimeType: "text/plain",
    })) };
    transcript.remember(id, cloudWorkspaceKey(a), { messages: [message], leadingPrompt: null });
    expect(transcript.peek(id)).not.toBeNull();
    await transcript.flush();
    expect(await cache(store).read(id)).toBeNull();
    expect(store.records.size).toBe(0);
  });

  it("trims cloud's disk tier on boot using unchanged character counts and LRU order", async () => {
    const store = new Store();
    let clock = 0;
    const transcript = cache(store, ownerA, { now: () => ++clock });
    for (const native of ["old", "middle", "new"])
      transcript.remember(cloudScopedId(a, native), cloudWorkspaceKey(a), window("text"));
    await transcript.flush();
    const json = [...store.records.values()][0].json;
    const restarted = cache(store, ownerA, { diskEntries: 2, diskBytes: json.length * 2 });
    await restarted.flush();
    expect([...store.index.values()].map(entry => entry.bytes)).toEqual([json.length, json.length]);
    expect(await restarted.read(cloudScopedId(a, "old"))).toBeNull();
    expect(await restarted.read(cloudScopedId(a, "middle"))).not.toBeNull();
    expect(await restarted.read(cloudScopedId(a, "new"))).not.toBeNull();
  });

  it("restores the exact account, organization, workspace and chat after restart", async () => {
    const store = new Store(), first = cache(store);
    for (const [target, text] of [[a, "A"], [b, "B"], [c, "C"]] as const)
      first.remember(cloudScopedId(target, "same-native-id"), cloudWorkspaceKey(target), window(text));
    const id = cloudScopedId(a, "same-native-id");
    expect(first.peek(id)?.messages[0]).toMatchObject({ text: "A" });
    await first.flush();
    expect(store.records.size).toBe(3);
    const restarted = cache(store);
    for (const [target, text] of [[a, "A"], [b, "B"], [c, "C"]] as const)
      expect((await restarted.read(cloudScopedId(target, "same-native-id")))?.messages[0]).toMatchObject({ text });
    expect(await cache(store, ownerB).read(id)).toBeNull();
    expect(await cache(store, accountPresentationOwner("https://other.example.test", "account-a")).read(id)).toBeNull();
    expect(await new LocalTranscriptCache({ store }).read(id)).toBeNull();
  });

  it("refuses unscoped, foreign-workspace and malformed cloud identities", () => {
    const transcript = cache();
    const id = cloudScopedId(a, "chat");
    for (const [chatId, folder] of [["chat", cloudWorkspaceKey(a)], [id, "/local"], [id, cloudWorkspaceKey(b)], ["cloud:invalid", cloudWorkspaceKey(a)], [id.replace(/chat$/, "%zz"), cloudWorkspaceKey(a)]])
      expect(() => transcript.remember(chatId, folder, window("foreign"))).not.toThrow();
    expect(transcript.memoryStats().entries).toBe(0);
  });

  it("fences a disk read across account A → B → A", async () => {
    const store = new Store(), id = cloudScopedId(a, "chat");
    const first = cache(store);
    first.remember(id, cloudWorkspaceKey(a), window("retired"));
    expect(first.peek(id)).not.toBeNull();
    await first.flush();
    const held = deferred<LocalTranscriptRecord | null>(), started = deferred<void>();
    const old = [...store.records.values()][0];
    vi.spyOn(store, "read").mockImplementationOnce(async () => { started.resolve(); return held.promise; });
    const reader = cache(store), pending = reader.read(id);
    await started.promise;
    reader.bindOwner(ownerB, true);
    reader.bindOwner(ownerA, true);
    held.resolve(old);
    expect(await pending).toBeNull();
    expect(reader.peek(id)).toBeNull();
    await reader.flush();
    expect(await cache(store).read(id)).toBeNull();
  });

  it("fences an index load across account A → B → A", async () => {
    const store = new Store(), id = cloudScopedId(a, "chat"), first = cache(store);
    first.remember(id, cloudWorkspaceKey(a), window("retired"));
    await first.flush();
    const entries = await store.readIndex(), held = deferred<LocalTranscriptIndexEntry[]>(), started = deferred<void>();
    vi.spyOn(store, "readIndex").mockImplementationOnce(async () => { started.resolve(); return held.promise; });
    const reader = cache(store), pending = reader.read(id);
    await started.promise;
    reader.bindOwner(ownerB, true);
    reader.bindOwner(ownerA, true);
    held.resolve(entries);
    expect(await pending).toBeNull();
    await reader.flush();
    expect(reader.peek(id)).toBeNull();
    expect(await cache(store).read(id)).toBeNull();
  });

  it("orders retirement after an already pending write, before new account writes", async () => {
    const store = new Store(), id = cloudScopedId(a, "chat"), transcript = cache(store);
    const held = deferred<void>(), started = deferred<void>(), commit = store.commit.bind(store);
    vi.spyOn(store, "commit").mockImplementationOnce(async change => { started.resolve(); await held.promise; await commit(change); });
    transcript.remember(id, cloudWorkspaceKey(a), window("retired"));
    expect(transcript.peek(id)).not.toBeNull();
    const pending = transcript.flush();
    await started.promise;
    transcript.bindOwner(ownerB, true);
    transcript.bindOwner(ownerA, true);
    expect(transcript.peek(id)).toBeNull();
    transcript.remember(id, cloudWorkspaceKey(a), window("new lifetime"));
    held.resolve();
    await pending;
    await transcript.flush();
    expect((await cache(store).read(id))?.messages[0]).toMatchObject({ text: "new lifetime" });
    expect(store.records.size).toBe(1);
  });

  it("cannot restore a retired lifetime after a failed purge and a renderer restart", async () => {
    const store = new Store(), id = cloudScopedId(a, "chat"), transcript = cache(store);
    transcript.remember(id, cloudWorkspaceKey(a), window("retired"));
    await transcript.flush();
    const commit = store.commit.bind(store);
    vi.spyOn(store, "commit").mockImplementation(change => change.clear
      ? Promise.reject(new Error("unavailable")) : commit(change));
    transcript.bindOwner(null, true);
    await transcript.flush();
    // The physical bytes remain, but the durable lifetime must be retired.
    expect(store.records.size).toBe(1);
    const restarted = cache(store);
    expect(await restarted.read(id)).toBeNull();
    restarted.remember(id, cloudWorkspaceKey(a), window("new lifetime"));
    await restarted.flush();
    expect((await cache(store).read(id))?.messages[0]).toMatchObject({ text: "new lifetime" });
  });

  it("prunes chat and workspace copies without touching the same native chat elsewhere", async () => {
    const store = new Store(), transcript = cache(store);
    for (const target of [a, b]) for (const native of ["chat", "sibling"])
      transcript.remember(cloudScopedId(target, native), cloudWorkspaceKey(target), window(native));
    await transcript.flush();
    transcript.forget(cloudScopedId(a, "chat"));
    transcript.retain((_chatId, folder) => folder !== cloudWorkspaceKey(b));
    await transcript.flush();
    const restarted = cache(store);
    expect(await restarted.read(cloudScopedId(a, "chat"))).toBeNull();
    expect(await restarted.read(cloudScopedId(b, "sibling"))).toBeNull();
    expect(await restarted.read(cloudScopedId(a, "sibling"))).not.toBeNull();
  });

  it("persists an edit whose text length and timestamps did not change", async () => {
    const store = new Store(), transcript = cache(store), id = cloudScopedId(a, "chat");
    transcript.remember(id, cloudWorkspaceKey(a), window("before"));
    await transcript.flush();
    transcript.remember(id, cloudWorkspaceKey(a), window("edited"));
    await transcript.flush();
    expect((await cache(store).read(id))?.messages[0]).toMatchObject({ text: "edited" });
  });

  it("rejects corrupt, malformed and oversized persisted rows", async () => {
    const id = cloudScopedId(a, "chat");
    for (const json of ["{broken", JSON.stringify({ version: 1, messages: [{ id: "x", kind: "text", createdAt: 1 }], leadingPrompt: null }),
      JSON.stringify({ version: 1, ...window("x".repeat(LOCAL_TRANSCRIPT_ENTRY_BYTES)) })]) {
      const store = new Store(), first = cache(store);
      first.remember(id, cloudWorkspaceKey(a), window("valid"));
      await first.flush();
      const key = [...store.records.keys()][0];
      store.records.set(key, { chatId: key, json });
      const second = cache(store);
      expect(await second.read(id)).toBeNull();
      await second.flush();
      expect(store.records.size).toBe(0);
    }
  });

  it.each([
    { ...row("text"), attachments: {} },
    { ...row("text"), segments: [{ type: "mention", label: "file", path: 42, kind: "file" }] },
    { ...row("text"), updatedAt: "later" },
    { id: "tool", kind: "tool", toolCallId: "tool", title: "Read", status: "completed", createdAt: 1, updatedAt: 2,
      content: [{ type: "content", content: null }] },
    { id: "question", kind: "question", source: "native_tool", blocking: false, createdAt: 1,
      questions: [{ id: "q", prompt: "Pick", inputType: "choice", options: [null] }] },
  ])("rejects malformed nested presentation fields: %j", message => {
    expect(decodeCloudTranscriptWindow(JSON.stringify({ version: 1, messages: [message], leadingPrompt: null }))).toBeNull();
  });

  it("degrades to memory without IndexedDB and retries after quota failure", async () => {
    const id = cloudScopedId(a, "chat"), memory = cache(null), messages = window("memory");
    memory.remember(id, cloudWorkspaceKey(a), messages);
    await memory.flush();
    expect(memory.peek(id)?.messages).toBe(messages.messages);
    const store = new Store(), transcript = cache(store);
    vi.spyOn(store, "commit").mockRejectedValueOnce(new DOMException("Quota", "QuotaExceededError"));
    transcript.remember(id, cloudWorkspaceKey(a), window("disk"));
    await expect(transcript.flush()).resolves.toBeUndefined();
    expect(transcript.peek(id)).not.toBeNull();
    transcript.remember(id, cloudWorkspaceKey(a), window("disk"));
    await transcript.flush();
    expect(decodeCloudTranscriptWindow([...store.records.values()][0].json)?.messages[0]).toMatchObject({ text: "disk" });
  });
});
