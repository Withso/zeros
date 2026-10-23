import { expect, it, vi } from "vitest";
import { createCloudPromptJournal } from "../cloud-prompt-journal";
import type { CloudPromptOwner, PromptJournalEntry } from "../cloud-prompt-channel";

const owner: CloudPromptOwner = { backend: "https://api.example.test", accountId: "fixture", organizationId: "org", workspaceId: "workspace", chatId: "chat" };
const entry = (id: string, chatId = "chat"): PromptJournalEntry => ({ order: 0, phase: "pending", updatedAt: Date.now(), payload: {
  chatId, userMessageId: id, agentId: "codex", prompt: [{ type: "text", text: "ok" }], startedAt: 1,
} });

/** Minimal transactional IDB harness. Writes are invisible until commit and
 * aborted transactions discard them, including a successful put request. */
function database() {
  const data = new Map<string, Map<string, any>>(), indexes = new Map<string, string>();
  const state = { failOpen: false, abortCommit: false, durability: "", entryWrites: 0 };
  const factory = { open() {
    const request: any = {};
    queueMicrotask(() => {
      if (state.failOpen) { request.error = new Error("Unavailable"); request.onerror?.(); return; }
      const fresh = !data.size;
      request.result = { close() {}, createObjectStore(name: string) {
        data.set(name, new Map()); return { createIndex(index: string, field: string) { indexes.set(name + index, field); } };
      }, transaction(names: string[], _mode: string, options?: { durability: string }) {
        state.durability = options?.durability ?? "";
        let pending = 0, ended = false;
        const copy = new Map([...data].map(([name, rows]) => [name, new Map(rows)]));
        const tx: any = { abort() { if (!ended) { ended = true; queueMicrotask(() => tx.onabort?.()); } }, objectStore(name: string) {
          if (!names.includes(name)) throw new Error("Wrong transaction store");
          const rows = copy.get(name)!;
          const run = (fn: () => unknown) => {
            pending++; const r: any = {};
            queueMicrotask(() => { if (ended) return; r.result = structuredClone(fn()); pending--; r.onsuccess?.();
              queueMicrotask(() => { if (ended || pending) return; if (state.abortCommit) { tx.abort(); return; }
                ended = true; for (const name of names) data.set(name, copy.get(name)!); tx.oncomplete?.(); });
            }); return r;
          };
          return { get: (key: string) => run(() => rows.get(key)), getAll: () => run(() => [...rows.values()]),
            index: (index: string) => ({ getAll: (value: string) => run(() => [...rows.values()].filter(row => row[indexes.get(name + index)!] === value)) }),
            put: (row: any) => run(() => { if (name === "entries") state.entryWrites++; rows.set(row.key, row); }),
            delete: (key: string) => run(() => { rows.delete(key); }) };
        } }; return tx;
      } };
      if (fresh) request.onupgradeneeded?.(); request.onsuccess?.();
    }); return request;
  } } as unknown as IDBFactory;
  return { factory, state };
}

it("fails closed when durable private storage is unavailable or aborts at commit", async () => {
  await expect(createCloudPromptJournal(undefined).change(owner, record => record)).rejects.toThrow(/storage/i);
  const f = database(), store = createCloudPromptJournal(f.factory);
  f.state.abortCommit = true;
  await expect(store.change(owner, record => ({ ...record, entries: [entry("one")] }))).rejects.toThrow(/storage/i);
  f.state.abortCommit = false; expect((await store.read(owner)).entries).toEqual([]);
});
it("requests strict durability, restores exact owners and writes only changed message rows", async () => {
  const f = database(), store = createCloudPromptJournal(f.factory);
  await store.change(owner, record => ({ ...record, entries: [entry("one")] }));
  expect(f.state.durability).toBe("strict");
  const reopened = createCloudPromptJournal(f.factory);
  expect((await reopened.read(owner)).entries[0]?.payload.userMessageId).toBe("one");
  expect((await reopened.read({ ...owner, accountId: "other" })).entries).toEqual([]);
  const writes = f.state.entryWrites;
  await reopened.change(owner, record => ({ ...record, cursor: "5" }));
  expect(f.state.entryWrites).toBe(writes); expect(await reopened.owners()).toEqual([owner]);
});
it("bounds saved bytes/rows and erases only the selected conversation", async () => {
  const f = database(), store = createCloudPromptJournal(f.factory, { maxBytes: 4000, maxEntries: 2 });
  await store.change(owner, record => ({ ...record, entries: [entry("one"), entry("two")] }));
  await expect(store.change(owner, record => ({ ...record, entries: [...record.entries, entry("three")] }))).rejects.toThrow(/full/i);
  await store.erase(owner); expect((await store.read(owner)).entries).toEqual([]);
  await expect(store.change(owner, record => ({ ...record, entries: [{ ...entry("large"), payload: { ...entry("large").payload,
    prompt: [{ type: "text", text: "x".repeat(4001) }] } }] }))).rejects.toThrow(/full/i);
});
it("expires terminal bodies and their owner metadata without dropping a pending Stop fence", async () => {
  vi.useFakeTimers();
  try {
    const f = database(), store = createCloudPromptJournal(f.factory), stopped = { ...owner, chatId: "stopped" };
    await store.change(owner, record => ({ ...record, entries: [{ ...entry("one"), phase: "saved", state: "completed" }] }));
    await store.change(stopped, record => ({ ...record, stop: { id: "stop", before: 1 }, entries: [{ ...entry("cancelled", "stopped"), phase: "saved", state: "cancelled" }] }));
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60_000);
    const active = { ...owner, chatId: "active" };
    await store.change(active, record => ({ ...record, entries: [entry("pending", "active")] }));
    expect((await store.read(owner)).entries).toEqual([]);
    expect(await store.owners()).toEqual(expect.arrayContaining([stopped, active]));
    expect(await store.owners()).not.toContainEqual(owner);
    expect((await store.read(stopped)).stop?.id).toBe("stop");
  } finally { vi.useRealTimers(); }
});

it("reads old journal entries and discards malformed optional presentation without losing retry bytes", async () => {
  const f = database(), store = createCloudPromptJournal(f.factory);
  const old = entry("old"), malformed = { ...entry("bad"), presentation: { startedAt: -1, endedAt: "later", status: "cancelled", source: "stop" } };
  await store.change(owner, record => ({ ...record, entries: [old, malformed as unknown as PromptJournalEntry] }));
  const restored = await createCloudPromptJournal(f.factory).read(owner);
  expect(restored.entries.map(row => row.payload)).toEqual([old.payload, malformed.payload]);
  expect(restored.entries.every(row => row.presentation === undefined)).toBe(true);
});
