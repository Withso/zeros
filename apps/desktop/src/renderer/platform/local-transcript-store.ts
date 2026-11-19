// Local and cloud use separate purgeable presentation caches; the authoritative transcript replaces any cached paint.

import { createIndexedDbRecordStore } from "./indexeddb-record-store";

export interface LocalTranscriptRecord {
  chatId: string;
  /** Store serialized JSON to bound clone work and measure the serialized size. */
  json: string;
}

/** Metadata supports eviction without loading transcript bytes. */
export interface LocalTranscriptIndexEntry {
  chatId: string;
  folder: string;
  /** Serialized character count; the original Local v1 accounting unit. */
  bytes: number;
  savedAt: number;
  readAt: number;
}

export interface LocalTranscriptStore {
  readIndex(): Promise<LocalTranscriptIndexEntry[]>;
  read(chatId: string): Promise<LocalTranscriptRecord | null>;
  /** Replace records and index rows, and delete `remove`, in one transaction. */
  commit(change: {
    clear?: boolean;
    put?: Array<{ record: LocalTranscriptRecord; entry: LocalTranscriptIndexEntry }>;
    touch?: LocalTranscriptIndexEntry[];
    remove?: string[];
  }): Promise<void>;
}

const WINDOWS = "windows";

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

export function createIndexedDbTranscriptStore(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined"
    ? undefined
    : indexedDB,
  namespace: "local" | "cloud" = "local",
): LocalTranscriptStore | null {
  const store = createIndexedDbRecordStore<LocalTranscriptRecord, LocalTranscriptIndexEntry>({
    factory,
    // The Local database name is a compatibility contract.
    database: `zeros:${namespace}-transcripts:v1`,
    records: WINDOWS,
    keyPath: "chatId",
    isEntry: isIndexEntry,
    record: (value, chatId) => {
      const record = value as Partial<LocalTranscriptRecord> | undefined;
      return record?.chatId === chatId && typeof record.json === "string"
        ? { chatId, json: record.json }
        : null;
    },
  });
  if (!store) return null;
  return {
    readIndex: () => store.readIndex(),
    read: async (chatId) => (await store.read([chatId]))[0] ?? null,
    commit: (change) => store.commit(change),
  };
}
