import {
  onNativeBeforeQuit,
  prepareNativeAttachmentFile,
  maintainNativeAttachmentSources,
} from "../../platform/runtime";
import {
  ATTACHMENT_SOURCE_GRACE_MS,
  isAttachmentSourceId,
} from "@zeros/protocol/attachment-policy";
import {
  registerAttachmentSourceOwner,
  retainedAttachmentSourceIds,
  rememberedAttachmentClipboardSources,
} from "./attachment-source-retention";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import type { ComposerAttachment } from "./composer-attachments";

type Source = { blob?: Blob; nativeSourceId?: string };
const pending = new Map<string, Promise<Source>>();
const preparing = new Set<string>();
interface StoredSource {
  version: 1;
  blob: Blob;
  touchedAt: number;
}
const storedSource = (blob: Blob): StoredSource => ({
  version: 1,
  blob,
  touchedAt: Date.now(),
});
function sourceBlob(value: unknown): Blob | undefined {
  if (value instanceof Blob) return value; // Existing v1 databases stored raw Blobs.
  const record = value as Partial<StoredSource> | undefined;
  return record?.version === 1 && record.blob instanceof Blob
    ? record.blob
    : undefined;
}
let stopQuitPreparation: (() => void) | undefined;
if (import.meta.hot) import.meta.hot.dispose(() => stopQuitPreparation?.());

/** Upgrade an old inline draft in memory before its bytes leave the composer. */
export function supplyLegacyAttachmentBytes(a: ComposerAttachment): void {
  if (a.sourceFile) return;
  if (a.kind === "text" && typeof a.text === "string") {
    // Old transcript/draft chips use an empty placeholder for saved text.
    // Resolve that record instead of manufacturing bytes that replace it.
    if (a.text === "" && (a.diskPath || a.contextAttachmentId)) return;
    a.sourceFile = new Blob([a.text], { type: a.mimeType });
  } else if (a.kind === "image" && a.data) {
    a.sourceFile = new Blob(
      [Uint8Array.from(atob(a.data), (char) => char.charCodeAt(0))],
      { type: a.mimeType },
    );
  }
  if (a.sourceFile) a.size = a.sourceFile.size;
}

/** IndexedDB keeps generated/remote upload bytes outside synchronous draft
 * JSON. Native local files need only the private selected-file capability. */
async function sourceStore<T>(
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("zeros:attachment-sources:v1", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("sources");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction("sources", "readwrite");
      let request: IDBRequest<T>;
      try {
        request = run(transaction.objectStore("sources"));
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      transaction.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error ?? request.error);
      };
    };
  });
}

export function prepareAttachmentSource(
  attachment: ComposerAttachment,
): Promise<Source> {
  stopQuitPreparation ??= onNativeBeforeQuit(async () => {
    await Promise.allSettled(pending.values());
  });
  const id = (attachment.sourceRecoveryId ??= crypto.randomUUID());
  const existing = pending.get(id);
  if (existing) return existing;
  preparing.add(id);
  const task = (async (): Promise<Source> => {
    const blob = attachment.sourceFile;
    const local = getActiveBridge()?.executionIdentity?.kind !== "cloud";
    if (blob) {
      if (local) {
        const nativeSourceId = await prepareNativeAttachmentFile(blob, id);
        if (nativeSourceId) return { nativeSourceId };
      }
      await sourceStore((store) => store.put(storedSource(blob), id));
      return { blob };
    }
    const recovered = sourceBlob(
      await sourceStore<unknown>((store) => store.get(id)),
    );
    if (recovered) {
      await sourceStore((store) => store.put(storedSource(recovered), id));
      return { blob: recovered };
    }
    // The id is serialized synchronously, before native registration finishes.
    // A restored local draft can reopen that capability after an app restart.
    if (local) return { nativeSourceId: id };
    throw new Error(
      "The unfinished attachment is not available — attach it again",
    );
  })().finally(() => {
    preparing.delete(id);
  });
  pending.set(id, task);
  void task.catch(() => {
    if (pending.get(id) === task) pending.delete(id);
  });
  return task;
}

export async function releaseAttachmentSource(
  id: string | undefined,
): Promise<void> {
  if (!id) return;
  pending.delete(id);
  // Another workspace upload, editor undo entry or clipboard can share this
  // source. Maintenance releases bytes only after checking all owners.
}

let maintenance: Promise<void> | undefined;
let lastCleanupKey: IDBValidKey | undefined;

export function maintainAttachmentSources(): Promise<void> {
  if (maintenance) return maintenance;
  const run = async () => {
    const retained = retainedAttachmentSourceIds(
      [...preparing].map((sourceRecoveryId) => ({ sourceRecoveryId })),
    );
    if (!retained) return;
    const clipboardIds =
      (await maintainNativeAttachmentSources(retained)) ??
      rememberedAttachmentClipboardSources();
    const current = retainedAttachmentSourceIds(
      [...clipboardIds, ...preparing].map((sourceRecoveryId) => ({
        sourceRecoveryId,
      })),
    );
    if (!current) return;
    const keep = new Set(current);
    for (const id of pending.keys())
      if (!keep.has(id) && !preparing.has(id)) pending.delete(id);
    await sourceStore((store) => {
      const cursor = store.openCursor(
        lastCleanupKey === undefined
          ? undefined
          : IDBKeyRange.lowerBound(lastCleanupKey, true),
      );
      let visited = 0;
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) {
          lastCleanupKey = undefined;
          return;
        }
        lastCleanupKey = row.key;
        const value: unknown = row.value;
        if (isAttachmentSourceId(row.key)) {
          if (value instanceof Blob) row.update(storedSource(value));
          else {
            const record = value as Partial<StoredSource> | undefined;
            if (
              sourceBlob(record) &&
              Number.isFinite(record?.touchedAt) &&
              Date.now() - record!.touchedAt! >= ATTACHMENT_SOURCE_GRACE_MS &&
              !keep.has(row.key) &&
              !preparing.has(row.key)
            )
              row.delete();
          }
        }
        if (++visited < 1000) row.continue();
      };
      return cursor;
    });
  };
  const task = run().finally(() => {
    if (maintenance === task) maintenance = undefined;
  });
  maintenance = task;
  return task;
}

/** App-level idle maintenance; no work is attached to typing or hidden panels. */
export function startAttachmentSourceMaintenance(
  readDrafts: () => unknown,
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined")
    return () => {};
  const unregister = registerAttachmentSourceOwner(readDrafts);
  let lastRun = 0;
  const sweep = () => {
    if (document.hidden || Date.now() - lastRun < 60_000) return;
    lastRun = Date.now();
    void maintainAttachmentSources().catch(() => {});
  };
  const first = window.setTimeout(sweep, 5000);
  const interval = window.setInterval(sweep, 10 * 60_000);
  document.addEventListener("visibilitychange", sweep);
  return () => {
    unregister();
    window.clearTimeout(first);
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", sweep);
  };
}
