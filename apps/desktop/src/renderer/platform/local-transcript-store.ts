// ──────────────────────────────────────────────────────────
// Transcript store — IndexedDB backend for the boot presentation caches
// ──────────────────────────────────────────────────────────
//
// The engine's zeros.db is the transcript authority. This store only keeps a
// bounded presentation copy of recently opened chats in separate Local/cloud
// namespaces, so a cold tab can paint before authoritative history answers. It lives
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

/** Boot reads must not pay an open per chat: one long-lived connection
 * (indexeddb-record-store.ts owns its lifecycle). */
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
