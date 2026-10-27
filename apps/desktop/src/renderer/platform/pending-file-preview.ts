import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { MAX_FILE_MEDIA_BYTES, fileMediaType } from "@zeros/protocol/file-media";
import { workspaceFileAccessKey } from "./workspace-file-scope";
import type { ReadFileResult } from "./files";
import { useDocumentActive } from "../state/use-document-active";

interface PendingFile { blob?: Blob; bytes: number; complete: boolean; viewers: number }
const entries = new Map<string, PendingFile>();
const listeners = new Map<string, Set<() => void>>();
function keyFor(cwd: string, path: string): string {
  return JSON.stringify([workspaceFileAccessKey(cwd), path]);
}
function notify(key: string) { for (const listener of listeners.get(key) ?? []) listener(); }
function trim() {
  let bytes = [...entries.values()].reduce((sum, entry) => sum + (entry.viewers ? 0 : entry.blob?.size ?? 0), 0);
  for (const [key, entry] of entries) {
    if (entries.size <= 16 && bytes <= 2 * MAX_FILE_MEDIA_BYTES) break;
    if (entry.viewers) continue;
    entries.delete(key); bytes -= entry.blob?.size ?? 0; notify(key);
  }
}

/** Borrows the selected File/Blob; no copy, base64 or extra disk snapshot.
 * Completed uploads retire immediately unless an open view holds a lease. */
export function offerPendingFilePreview(cwd: string, path: string, blob: Blob): () => void {
  if (!fileMediaType(path)) return () => {};
  const key = keyFor(cwd, path);
  let entry = entries.get(key);
  if (!entry) {
    entry = { blob: blob.size <= MAX_FILE_MEDIA_BYTES ? blob : undefined, bytes: blob.size, complete: false, viewers: 0 };
    entries.set(key, entry); trim(); notify(key);
  }
  return () => {
    const current = entries.get(key);
    if (!current) return;
    current.complete = true;
    if (!current.viewers) { entries.delete(key); notify(key); }
  };
}
export function hasPendingFilePreview(cwd: string, path: string): boolean { return entries.has(keyFor(cwd, path)); }

export function acquirePendingFilePreview(cwd: string, path: string): { blob?: Blob; bytes: number; url: string | undefined; release(): void } | null {
  const key = keyFor(cwd, path), entry = entries.get(key);
  if (!entry) return null;
  entry.viewers++;
  const mime = fileMediaType(path)!.mimeType;
  // A slice shares the Blob's backing bytes. Only correct picker metadata
  // (for example text/plain SVGs); never read/copy the file to fix its MIME.
  const source = entry.blob && entry.blob.type !== mime
    ? entry.blob.slice(0, entry.blob.size, mime) : entry.blob;
  const url = source ? URL.createObjectURL(source) : undefined;
  let released = false;
  return { blob: entry.blob, bytes: entry.bytes, url, release: () => {
    if (released) return;
    released = true;
    if (url) URL.revokeObjectURL(url);
    entry.viewers--;
    if (!entry.viewers && entry.complete && entries.get(key) === entry) { entries.delete(key); notify(key); }
    trim();
  } };
}

export function usePendingFilePreview(cwd: string | undefined, path: string, active: boolean): ReadFileResult | null {
  const visible = useDocumentActive(active);
  const key = cwd ? keyFor(cwd, path) : "";
  const entry = useSyncExternalStore(useCallback(listener => {
    if (!key) return () => {};
    let set = listeners.get(key);
    if (!set) listeners.set(key, set = new Set());
    set.add(listener);
    return () => { set!.delete(listener); if (!set!.size) listeners.delete(key); };
  }, [key]), useCallback(() => entries.get(key) ?? null, [key]), () => null);
  const [lease, setLease] = useState<{ key: string; value: NonNullable<ReturnType<typeof acquirePendingFilePreview>> } | null>(null);
  useLayoutEffect(() => {
    if (!cwd || !visible || !entry) return;
    const value = acquirePendingFilePreview(cwd, path);
    if (!value) return;
    setLease({ key, value });
    return () => { value.release(); setLease(current => current?.value === value ? null : current); };
  }, [visible, cwd, path, key, entry]);
  if (!entry) return null;
  return { kind: entry.bytes > MAX_FILE_MEDIA_BYTES ? "too-large" : fileMediaType(path)!.kind, path, bytes: entry.bytes,
    dataUrl: lease?.key === key ? lease.value.url : undefined };
}
