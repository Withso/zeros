import { CloudV2PromptSchema } from "@zeros/protocol/cloud-v2-prompts";
import { emptyPromptJournal, promptOwnerKey, promptTerminal, type CloudPromptJournal, type CloudPromptOwner,
  type PromptJournalEntry, type PromptJournalRecord } from "./cloud-prompt-channel";

type Meta = Omit<PromptJournalRecord, "entries"> & { key: string; pending?: boolean };
type StoredEntry = { key: string; ownerKey: string; entry: PromptJournalEntry };
type Size = { key: string; bytes: number; expiresAt: number | null };
const STORES = ["chats", "entries", "sizes"];
const RETAIN_MS = 7 * 24 * 60 * 60_000;
const unavailable = () => new Error("Private message storage is unavailable. Your draft has been kept; try again.");

/** This is a retry journal, not a purgeable transcript cache. There is no
 * memory fallback and a successful put is not acceptance: wait for the strict
 * transaction's commit. Bodies live in separate rows so status refreshes do
 * not rewrite every attachment in the conversation. No credentials live here. */
export function createCloudPromptJournal(factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB,
  limits = { maxBytes: 64 * 1024 * 1024, maxEntries: 2048 }): CloudPromptJournal {
  const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    if (!factory) { reject(unavailable()); return; }
    const request = factory.open("zeros:cloud-prompt-outbox:v1", 1);
    let ended = false;
    const timer = setTimeout(() => { ended = true; reject(unavailable()); }, 10_000);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("chats", { keyPath: "key" });
      request.result.createObjectStore("entries", { keyPath: "key" }).createIndex("owner", "ownerKey");
      request.result.createObjectStore("sizes", { keyPath: "key" });
    };
    request.onerror = () => { clearTimeout(timer); ended = true; reject(unavailable()); };
    request.onsuccess = () => { clearTimeout(timer); if (ended) request.result.close(); else { ended = true; resolve(request.result); } };
  });
  const transaction = async <T>(write: boolean, run: (tx: IDBTransaction, result: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        let value: T, error: Error | undefined;
        const tx = db.transaction(STORES, write ? "readwrite" : "readonly", write ? { durability: "strict" } : undefined);
        const fail = (failure: Error) => { error = failure; tx.abort(); };
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(error ?? unavailable());
        try { run(tx, next => { value = next; }, fail); } catch (failure) { fail(failure instanceof Error ? failure : unavailable()); }
      });
    } finally { db.close(); }
  };
  const read = (tx: IDBTransaction, owner: CloudPromptOwner, done: (record: PromptJournalRecord) => void, fail: (error: Error) => void) => {
    const key = promptOwnerKey(owner), meta = tx.objectStore("chats").get(key), rows = tx.objectStore("entries").index("owner").getAll(key);
    let ready = 0;
    const received = () => {
      if (++ready !== 2) return;
      try {
        const stored = meta.result as Meta | undefined;
        if (stored && (stored.version !== 1 || promptOwnerKey(stored.owner) !== key)) throw unavailable();
        const entries = (rows.result as StoredEntry[]).map(row => {
          if (row.ownerKey !== key || !CloudV2PromptSchema.safeParse(row.entry?.payload).success || row.entry.payload.chatId !== owner.chatId) throw unavailable();
          return row.entry;
        }).sort((a, b) => a.order - b.order);
        done({ ...(stored ?? emptyPromptJournal(owner)), entries });
      } catch (error) { fail(error instanceof Error ? error : unavailable()); }
    };
    meta.onsuccess = received; rows.onsuccess = received;
  };
  return {
    read: owner => transaction(false, (tx, done, fail) => read(tx, owner, done, fail)),
    change: (owner, update) => transaction(true, (tx, done, fail) => {
      const key = promptOwnerKey(owner), sizesRequest = tx.objectStore("sizes").getAll();
      let record: PromptJournalRecord | undefined, sizes: Size[] | undefined;
      const apply = () => {
        if (!record || !sizes) return;
        try {
          const entriesStore = tx.objectStore("entries"), sizesStore = tx.objectStore("sizes"), now = Date.now();
          const expired = new Set(sizes.filter(size => size.expiresAt !== null && size.expiresAt < now).map(size => size.key));
          const indexes = new Map(sizes.filter(size => !expired.has(size.key)).map(size => [size.key, size]));
          const entryKey = (entry: PromptJournalEntry) => JSON.stringify([key, entry.payload.userMessageId]);
          for (const item of expired) { entriesStore.delete(item); sizesStore.delete(item); }
          const before = { ...record, entries: record.entries.filter(entry => !expired.has(entryKey(entry))) };
          const next = update(before);
          if (next.version !== 1 || promptOwnerKey(next.owner) !== key) throw unavailable();
          if (new Set(next.entries.map(entryKey)).size !== next.entries.length || next.entries.some(entry => entry.payload.chatId !== owner.chatId)) throw unavailable();
          const prior = new Map(before.entries.map(entry => [entryKey(entry), entry]));
          for (const entry of next.entries) {
            const id = entryKey(entry), old = prior.get(id); prior.delete(id);
            if (old === entry) continue;
            const bytes = new TextEncoder().encode(JSON.stringify(entry)).length;
            const size: Size = { key: id, bytes, expiresAt: promptTerminal(entry.state) || entry.phase === "refused" ? now + RETAIN_MS : null };
            indexes.set(id, size); sizesStore.put(size); entriesStore.put({ key: id, ownerKey: key, entry });
          }
          for (const id of prior.keys()) { indexes.delete(id); entriesStore.delete(id); sizesStore.delete(id); }
          if (indexes.size > limits.maxEntries || [...indexes.values()].reduce((total, value) => total + value.bytes, 0) > limits.maxBytes)
            throw new Error("Private message storage is full. Finish or remove saved conversations before sending more.");
          const retainedOwners = new Set([...indexes.keys()].map(id => (JSON.parse(id) as [string, string])[0]));
          for (const retired of new Set([...expired].map(id => (JSON.parse(id) as [string, string])[0]))) {
            if (retired === key || retainedOwners.has(retired)) continue;
            const metadata = tx.objectStore("chats").get(retired);
            metadata.onsuccess = () => { if (!(metadata.result as Meta | undefined)?.stop) tx.objectStore("chats").delete(retired); };
          }
          const { entries: _entries, ...metadata } = next;
          if (!next.entries.length && !next.stop) tx.objectStore("chats").delete(key);
          else tx.objectStore("chats").put({ ...metadata, key, pending: !!next.stop || next.entries.some(entry =>
            entry.phase === "pending" || entry.phase === "uncertain" || entry.receipt && !promptTerminal(entry.state)) });
          done(next);
        } catch (error) { fail(error instanceof Error ? error : unavailable()); }
      };
      sizesRequest.onsuccess = () => { sizes = sizesRequest.result as Size[]; apply(); };
      read(tx, owner, value => { record = value; apply(); }, fail);
    }),
    owners: pendingOnly => transaction(false, (tx, done) => {
      const request = tx.objectStore("chats").getAll(); request.onsuccess = () => done((request.result as Meta[])
        .filter(row => !pendingOnly || row.pending !== false).map(row => row.owner));
    }),
    erase: owner => transaction(true, (tx, done, fail) => {
      read(tx, owner, record => {
        const key = promptOwnerKey(owner);
        for (const entry of record.entries) {
          const id = JSON.stringify([key, entry.payload.userMessageId]); tx.objectStore("entries").delete(id); tx.objectStore("sizes").delete(id);
        }
        tx.objectStore("chats").delete(key); done(undefined);
      }, fail);
    }),
  };
}
