// The Chromium profile is purgeable; losing saved preview pictures rerenders from untouched Design source.

import { createIndexedDbRecordStore } from "./indexeddb-record-store";

export interface DesignPreviewRecord {
  key: string;
  blob: Blob;
}

/** Read the metadata index for bounds and eviction without loading image bytes. */
export interface DesignPreviewIndexEntry {
  key: string;
  /** Owner, workspace, directory, frame and theme; one record per preview level. */
  frameKey: string;
  workspaceId: string;
  level: "mini" | "thumbnail" | "overview" | "detail";
  sourceVersion: string;
  width: number;
  height: number;
  bytes: number;
  savedAt: number;
  readAt: number;
}

export interface DesignPreviewStore {
  readIndex(): Promise<DesignPreviewIndexEntry[]>;
  read(keys: readonly string[]): Promise<DesignPreviewRecord[]>;
  /** Replace records and index rows, and delete `remove`, in one transaction. */
  commit(change: {
    put?: Array<{ record: DesignPreviewRecord; entry: DesignPreviewIndexEntry }>;
    touch?: DesignPreviewIndexEntry[];
    remove?: string[];
  }): Promise<void>;
}

const DATABASE = "zeros:design-previews:v1";
const PICTURES = "pictures";

export function isDesignPreviewIndexEntry(value: unknown): value is DesignPreviewIndexEntry {
  const entry = value as Partial<DesignPreviewIndexEntry> | null;
  return (
    !!entry &&
    typeof entry.key === "string" &&
    typeof entry.frameKey === "string" &&
    typeof entry.workspaceId === "string" &&
    (entry.level === "mini" || entry.level === "thumbnail" || entry.level === "overview" || entry.level === "detail") &&
    typeof entry.sourceVersion === "string" &&
    Number.isSafeInteger(entry.width) && (entry.width ?? 0) > 0 &&
    Number.isSafeInteger(entry.height) && (entry.height ?? 0) > 0 &&
    Number.isSafeInteger(entry.bytes) && (entry.bytes ?? 0) > 0 &&
    Number.isFinite(entry.savedAt) &&
    Number.isFinite(entry.readAt)
  );
}

export function createIndexedDbDesignPreviewStore(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined"
    ? undefined
    : indexedDB,
): DesignPreviewStore | null {
  return createIndexedDbRecordStore<DesignPreviewRecord, DesignPreviewIndexEntry>({
    factory,
    database: DATABASE,
    records: PICTURES,
    keyPath: "key",
    isEntry: isDesignPreviewIndexEntry,
    record: (value, key) => {
      const record = value as Partial<DesignPreviewRecord> | undefined;
      return record?.key === key && record.blob instanceof Blob ? { key, blob: record.blob } : null;
    },
  });
}
