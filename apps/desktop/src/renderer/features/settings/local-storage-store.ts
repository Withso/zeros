import { useSyncExternalStore } from "react";
import {
  LOCAL_STORAGE_PROGRESS_EVENT,
  parseLocalStorageClearResult,
  parseLocalStorageReport,
  type LocalStorageCategoryId,
  type LocalStorageReport,
} from "../../../../shared/local-storage";
import { isElectron, nativeInvoke, nativeListen } from "../../platform/runtime";

/** One snapshot per device. Local Storage describes this Mac, so every owner
 * and placement reads the same key; an owner switch never refetches it. */
export interface LocalStorageView {
  report: LocalStorageReport | null;
  error: string | null;
  clearing: boolean;
  /** undefined: nothing cleared since the last measurement; null: cleared,
   * amount unknown (a side of the comparison was not measured). */
  freedBytes: number | null | undefined;
}

const MAX_AGE_MS = 5 * 60_000;
const EMPTY: LocalStorageView = Object.freeze({ report: null, error: null, clearing: false, freedBytes: undefined });

let view: LocalStorageView = EMPTY;
const listeners = new Set<() => void>();
let measuring: Promise<void> | null = null;
let viewers = 0;
let listening = false;
let stopListening: (() => void) | null = null;

function publish(patch: Partial<LocalStorageView>): void {
  view = { ...view, ...patch };
  for (const listener of listeners) listener();
}

/** Main's revision orders replies and progress events; an older one is dropped. */
function accept(report: LocalStorageReport): void {
  if (view.report && report.revision <= view.report.revision) return;
  publish({ report });
  settleListening();
}

function listen(): void {
  if (listening) return;
  listening = true;
  void nativeListen<unknown>(LOCAL_STORAGE_PROGRESS_EVENT, (payload) => {
    try {
      accept(parseLocalStorageReport(payload));
    } catch {
      /* a malformed event never replaces confirmed sizes */
    }
  }).then((off) => {
    if (listening && !stopListening) stopListening = off;
    else off();
  });
}

// Stay subscribed while main reports work, including a run it resumed after
// clearing the cache, so the final sizes always arrive.
function settleListening(): void {
  if (measuring || view.clearing || view.report?.measuring) return;
  listening = false;
  stopListening?.();
  stopListening = null;
}

/** The section measures sizes from the system's own tools on macOS only;
 * elsewhere it is hidden rather than showing numbers it cannot back. */
export function isLocalStorageSupported(): boolean {
  return isElectron() && typeof navigator !== "undefined" && /^Mac/i.test(navigator.platform ?? "");
}

export function getLocalStorageView(): LocalStorageView {
  return view;
}

export function subscribeLocalStorageView(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLocalStorageView(): LocalStorageView {
  return useSyncExternalStore(subscribeLocalStorageView, getLocalStorageView, getLocalStorageView);
}

/** Start a measurement unless one is running or the last one is recent.
 * Concurrent callers share the request; confirmed sizes stay on screen. */
export function ensureLocalStorageMeasured(options: { force?: boolean } = {}): void {
  if (!isLocalStorageSupported() || measuring || view.clearing) return;
  const report = view.report;
  const fresh = report && !report.measuring && report.measuredAt !== null && Date.now() - report.measuredAt < MAX_AGE_MS;
  if (fresh && !options.force) return;
  listen();
  publish({ error: null, freedBytes: undefined });
  measuring = nativeInvoke<unknown>("local_storage_measure")
    .then(
      (value) => accept(parseLocalStorageReport(value)),
      (error: unknown) => publish({ error: error instanceof Error ? error.message : "Could not measure Local Storage." }),
    )
    .finally(() => {
      measuring = null;
      settleListening();
    });
}

/** Pointer or focus intent on the Settings entry. */
export function warmLocalStorage(): void {
  ensureLocalStorageMeasured();
}

/** Stop the walk (main kills its du children) unless a view still wants it. */
export function cancelLocalStorageMeasurement(): void {
  if (viewers > 0 || (!measuring && !view.report?.measuring)) return;
  void nativeInvoke("local_storage_cancel").catch(() => {});
}

/** A visible Local Storage page. Releasing the last one cancels a walk in
 * flight; a remount in the same commit (an owner switch) keeps it. */
export function retainLocalStorageView(): () => void {
  viewers += 1;
  ensureLocalStorageMeasured();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    viewers -= 1;
    queueMicrotask(cancelLocalStorageMeasurement);
  };
}

export async function clearLocalStorageCache(): Promise<void> {
  if (view.clearing) return;
  listen();
  publish({ clearing: true, freedBytes: undefined, error: null });
  try {
    const result = parseLocalStorageClearResult(
      await nativeInvoke<unknown>("local_storage_clear_cache", { category: "cache" }),
    );
    accept(result.report);
    publish({ freedBytes: result.freedBytes });
  } finally {
    publish({ clearing: false });
    settleListening();
  }
}

export function revealLocalStorage(category: LocalStorageCategoryId): Promise<void> {
  return nativeInvoke("local_storage_reveal", { category });
}

export function _resetLocalStorageForTests(): void {
  view = EMPTY;
  listeners.clear();
  measuring = null;
  viewers = 0;
  listening = false;
  stopListening = null;
}
