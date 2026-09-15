import {
  onNativeBeforeQuit,
  prepareNativeAttachmentFile,
} from "../../platform/runtime";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import type { ComposerAttachment } from "./composer-attachments";

type Source = { blob?: Blob; nativeSourceId?: string };
const pending = new Map<string, Promise<Source>>();
let stopQuitPreparation: (() => void) | undefined;
if (import.meta.hot) import.meta.hot.dispose(() => stopQuitPreparation?.());

/** Upgrade an old inline draft in memory before its bytes leave the composer. */
export function supplyLegacyAttachmentBytes(a: ComposerAttachment): void {
  if (a.sourceFile) return;
  if (a.kind === "text" && typeof a.text === "string") {
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
  const task = (async (): Promise<Source> => {
    const blob = attachment.sourceFile;
    const local = getActiveBridge()?.executionIdentity?.kind !== "cloud";
    if (blob) {
      if (local) {
        const nativeSourceId = await prepareNativeAttachmentFile(blob, id);
        if (nativeSourceId) return { nativeSourceId };
      }
      await sourceStore((store) => store.put(blob, id));
      return { blob };
    }
    const recovered = await sourceStore<Blob | undefined>((store) =>
      store.get(id),
    );
    if (recovered instanceof Blob) return { blob: recovered };
    // The id is serialized synchronously, before native registration finishes.
    // A restored local draft can reopen that capability after an app restart.
    if (local) return { nativeSourceId: id };
    throw new Error(
      "The unfinished attachment is not available — attach it again",
    );
  })();
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
  await sourceStore((store) => store.delete(id));
}
