// ──────────────────────────────────────────────────────────
// Design preview store — IndexedDB backend for canvas pictures
// ──────────────────────────────────────────────────────────
//
// The Design source is the authority. This store only keeps encoded pictures
// of saved frames so a reopened canvas paints before anything renders. It
// lives in Chromium's session profile, which Electron main relocates to the
// purgeable OS cache directory (`relocateChromiumCache`): losing it costs one
// render per frame, never data. Policy (keys, bounds, eligibility) lives in
// features/design-workspace/state/design-frame-previews.ts; this file only
// moves records.
// ──────────────────────────────────────────────────────────

import { createIndexedDbRecordStore } from "./indexeddb-record-store";

export interface DesignPreviewRecord {
  key: string;
  blob: Blob;
}

/** Small metadata row loaded once per session to enforce bounds, LRU order
 * and stale fallbacks without reading any picture bytes. */
export interface DesignPreviewIndexEntry {
  key: string;
  /** Owner scope, workspace, directory, frame and theme; one picture per
   * level is kept for each. */
  frameKey: string;
  workspaceId: string;
  level: "thumbnail" | "overview" | "detail";
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
    (entry.level === "thumbnail" || entry.level === "overview" || entry.level === "detail") &&
    typeof entry.sourceVersion === "string" &&
    Number.isSafeInteger(entry.width) && (entry.width ?? 0) > 0 &&
    Number.isSafeInteger(entry.height) && (entry.height ?? 0) > 0 &&
    Number.isSafeInteger(entry.bytes) && (entry.bytes ?? 0) > 0 &&
    Number.isFinite(entry.savedAt) &&
    Number.isFinite(entry.readAt)
  );
}

/** A page open reads its pictures in one transaction over one long-lived
 * connection (indexeddb-record-store.ts owns its lifecycle). */
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
