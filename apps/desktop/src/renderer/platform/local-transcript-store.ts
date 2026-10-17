// ──────────────────────────────────────────────────────────
// Local transcript store — IndexedDB backend for the boot cache
// ──────────────────────────────────────────────────────────
//
// The engine's zeros.db is the transcript authority. This store only keeps a
// bounded presentation copy of recently opened Local chats so a restart, an
// engine respawn or a cold tab can paint before the engine answers. It lives
// in Chromium's session profile, which Electron main relocates to the
// purgeable OS cache directory (`relocateChromiumCache`): losing it costs one
// cold read, never data. Policy (bounds, eligibility, scheduling) lives in
// state/local-transcript-cache.ts; this file only moves records.
// ──────────────────────────────────────────────────────────

export interface LocalTranscriptRecord {
  chatId: string;
  /** Serialized `{ version, messages, leadingPrompt }`. A string keeps the
   * structured clone cheap and makes the byte budget exact. */
  json: string;
}

/** Small metadata row loaded once per session to enforce bounds and LRU
 * order without reading any transcript bytes. */
export interface LocalTranscriptIndexEntry {
  chatId: string;
  folder: string;
  bytes: number;
  savedAt: number;
  readAt: number;
}

export interface LocalTranscriptStore {
  readIndex(): Promise<LocalTranscriptIndexEntry[]>;
  read(chatId: string): Promise<LocalTranscriptRecord | null>;
  /** Replace records and index rows, and delete `remove`, in one transaction. */
  commit(change: {
    put?: Array<{ record: LocalTranscriptRecord; entry: LocalTranscriptIndexEntry }>;
    touch?: LocalTranscriptIndexEntry[];
    remove?: string[];
  }): Promise<void>;
}

const DATABASE = "zeros:local-transcripts:v1";
const WINDOWS = "windows";
const INDEX = "index";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function isIndexEntry(value: unknown): value is LocalTranscriptIndexEntry {
  const entry = value as Partial<LocalTranscriptIndexEntry> | null;
  return (
    !!entry &&
    typeof entry.chatId === "string" &&
    typeof entry.folder === "string" &&
    Number.isSafeInteger(entry.bytes) &&
    (entry.bytes ?? -1) >= 0 &&
    Number.isFinite(entry.savedAt) &&
    Number.isFinite(entry.readAt)
  );
}

/** One long-lived connection: boot reads must not pay an open per chat. A
 * failed open disables the store for the session (the cache degrades to
 * memory-only), and a version change from another window closes it. */
export function createIndexedDbTranscriptStore(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined"
    ? undefined
    : indexedDB,
): LocalTranscriptStore | null {
  if (!factory) return null;
  let connection: Promise<IDBDatabase | null> | null = null;
  const database = (): Promise<IDBDatabase | null> => {
    connection ??= new Promise<IDBDatabase | null>((resolve) => {
      let open: IDBOpenDBRequest;
      try {
        open = factory.open(DATABASE, 1);
      } catch {
        resolve(null);
        return;
      }
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(WINDOWS)) db.createObjectStore(WINDOWS, { keyPath: "chatId" });
        if (!db.objectStoreNames.contains(INDEX)) db.createObjectStore(INDEX, { keyPath: "chatId" });
      };
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
      open.onsuccess = () => {
        const db = open.result;
        db.onversionchange = () => {
          db.close();
          connection = null;
        };
        resolve(db);
      };
    });
    return connection;
  };

  return {
    async readIndex() {
      const db = await database();
      if (!db) return [];
      const rows = await requestResult(
        db.transaction(INDEX, "readonly").objectStore(INDEX).getAll(),
      );
      return (rows as unknown[]).filter(isIndexEntry);
    },
    async read(chatId) {
      const db = await database();
      if (!db) return null;
      const value = (await requestResult(
        db.transaction(WINDOWS, "readonly").objectStore(WINDOWS).get(chatId),
      )) as Partial<LocalTranscriptRecord> | undefined;
      return value && value.chatId === chatId && typeof value.json === "string"
        ? { chatId, json: value.json }
        : null;
    },
    async commit(change) {
      const db = await database();
      if (!db) return;
      const transaction = db.transaction([WINDOWS, INDEX], "readwrite");
      const windows = transaction.objectStore(WINDOWS);
      const index = transaction.objectStore(INDEX);
      for (const chatId of change.remove ?? []) {
        windows.delete(chatId);
        index.delete(chatId);
      }
      for (const { record, entry } of change.put ?? []) {
        windows.put(record);
        index.put(entry);
      }
      for (const entry of change.touch ?? []) index.put(entry);
      await transactionDone(transaction);
    },
  };
}
