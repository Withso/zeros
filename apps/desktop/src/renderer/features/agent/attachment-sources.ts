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
const sourceIdForKey = (key: string) => key.replace(/:portable$/, "");
const sourceIsPreparing = (id: string) => preparing.has(id) || preparing.has(`${id}:portable`);
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
      let transaction: IDBTransaction;
      let request: IDBRequest<T>;
      try {
        transaction = db.transaction("sources", "readwrite");
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
  portable = false,
): Promise<Source> {
  portable ||= attachment.sourcePortable === true;
  stopQuitPreparation ??= onNativeBeforeQuit(async () => {
    await Promise.allSettled(pending.values());
  });
  const id = (attachment.sourceRecoveryId ??= crypto.randomUUID());
  const pendingKey = portable ? `${id}:portable` : id;
  const existing = pending.get(pendingKey);
  if (existing) return existing;
  preparing.add(pendingKey);
  const task = (async (): Promise<Source> => {
    if (attachment.sourcePortable && typeof indexedDB === "undefined")
      throw new Error("Attachment storage is unavailable on this device");
    // A recovery id owns immutable bytes, even after an upload releases the
    // memory entry. Another draft may still carry an original native File
    // whose pathname has since been modified or removed.
    const committed = portable ? sourceBlob(await sourceStore<unknown>(store => store.get(id))) : undefined;
    if (committed) {
      await sourceStore(store => store.put(storedSource(committed), id));
      attachment.sourceFile = committed;
      return { blob: committed };
    }
    const blob = attachment.sourceFile;
    const local = !portable && getActiveBridge()?.executionIdentity?.kind !== "cloud";
    if (blob) {
      if (local) {
        const nativeSourceId = await prepareNativeAttachmentFile(blob, id);
        if (nativeSourceId) return { nativeSourceId };
      }
      await sourceStore((store) => store.put(storedSource(blob), id));
      // The IDB Blob is a snapshot. A File from the picker may still depend on
      // the original native pathname, even after its recovery copy committed.
      const saved = portable ? sourceBlob(await sourceStore<unknown>((store) => store.get(id))) : undefined;
      if (attachment.sourcePortable && !saved) throw new Error("Attachment storage is unavailable on this device");
      if (saved) attachment.sourceFile = saved;
      return { blob: saved ?? blob };
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
    preparing.delete(pendingKey);
  });
  pending.set(pendingKey, task);
  void task.catch(() => {
    if (pending.get(pendingKey) === task) pending.delete(pendingKey);
  });
  return task;
}

export async function releaseAttachmentSource(
  id: string | undefined,
): Promise<void> {
  if (!id) return;
  pending.delete(id);
  pending.delete(`${id}:portable`);
  // Another workspace upload, editor undo entry or clipboard can share this
  // source. Maintenance releases bytes only after checking all owners.
}

const confirmedListeners = new Set<() => void>();
export function onAttachmentSourceConfirmed(listener: () => void): () => void {
  confirmedListeners.add(listener);
  return () => { confirmedListeners.delete(listener); };
}

/** Replace this owner's recovery handle only after the destination confirms
 * complete bytes. Other drafts, uploads, clipboard and open Blob leases keep
 * independent ownership; never delete the user's selected native file. */
export async function completeAttachmentSource(attachment: ComposerAttachment): Promise<void> {
  const id = attachment.sourceRecoveryId;
  if (!id || !attachment.diskPath || !attachment.owner) return;
  const path = attachment.diskPath, owner = attachment.owner;
  // An initial attach-time snapshot can still be finishing alongside a native
  // copy. Join it before deletion so it cannot recreate the cache afterward.
  await Promise.allSettled([pending.get(id), pending.get(`${id}:portable`)].filter(Boolean));
  if (attachment.sourceRecoveryId !== id || attachment.diskPath !== path || attachment.owner !== owner) return;
  delete attachment.sourceRecoveryId;
  delete attachment.sourceFile;
  delete attachment.sourcePortable;
  await releaseAttachmentSource(id);
  // Draft persistence must publish the confirmed reference before its recovery
  // bytes are reclaimed. If a writer fails, retain the bytes for recovery.
  for (const listener of confirmedListeners) listener();
  const retained = retainedAttachmentSourceIds();
  if (!retained) return;
  const clipboard = (await maintainNativeAttachmentSources(retained)) ?? rememberedAttachmentClipboardSources();
  const current = retainedAttachmentSourceIds(clipboard.map(sourceRecoveryId => ({ sourceRecoveryId })));
  if (!current || current.includes(id) || sourceIsPreparing(id)) return;
  await sourceStore(store => {
    const latest = retainedAttachmentSourceIds(clipboard.map(sourceRecoveryId => ({ sourceRecoveryId })));
    return !latest || latest.includes(id) || sourceIsPreparing(id) ? store.get(id) : store.delete(id);
  });
}

let maintenance: Promise<void> | undefined;
let lastCleanupKey: IDBValidKey | undefined;

export function maintainAttachmentSources(): Promise<void> {
  if (maintenance) return maintenance;
  const run = async () => {
    const retained = retainedAttachmentSourceIds(
      [...preparing].map((key) => ({ sourceRecoveryId: sourceIdForKey(key) })),
    );
    if (!retained) return;
    const clipboardIds =
      (await maintainNativeAttachmentSources(retained)) ??
      rememberedAttachmentClipboardSources();
    const current = retainedAttachmentSourceIds(
      [...clipboardIds, ...preparing].map((key) => ({
        sourceRecoveryId: sourceIdForKey(key),
      })),
    );
    if (!current) return;
    const keep = new Set(current);
    for (const key of pending.keys())
      if (!keep.has(sourceIdForKey(key)) && !sourceIsPreparing(sourceIdForKey(key))) pending.delete(key);
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
              !sourceIsPreparing(row.key)
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
