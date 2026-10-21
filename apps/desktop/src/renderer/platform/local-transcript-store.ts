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

import { createIndexedDbRecordStore } from "./indexeddb-record-store";

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

/** Boot reads must not pay an open per chat: one long-lived connection
 * (indexeddb-record-store.ts owns its lifecycle). */
export function createIndexedDbTranscriptStore(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined"
    ? undefined
    : indexedDB,
): LocalTranscriptStore | null {
  const store = createIndexedDbRecordStore<LocalTranscriptRecord, LocalTranscriptIndexEntry>({
    factory,
    database: DATABASE,
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
