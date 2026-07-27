// ──────────────────────────────────────────────────────────
// useViewedFiles — per-workspace "reviewed" state for the Changes flow
// ──────────────────────────────────────────────────────────
//
// A file the user marks "Viewed" (the checkbox in the row-1 diff header) dims in
// the Changes list and is skipped by the review sweep. State is keyed by the git
// target (a worktree id, or the trunk's repoRoot) and persisted, so it survives
// reloads and source-tab / workspace switches.
//
// The Changes view publishes, on every reload, two EPHEMERAL maps (not
// persisted): the ordered change paths (for the auto-advance sweep) and each
// file's current content hash. The hash drives AUTO-UNMARK — when a viewed file
// changes again (e.g. an agent edits it), its stored hash no longer matches, so
// it re-surfaces as unviewed the moment the list refreshes (live refresh).
// Hashes are authoritative in the default "All changes" scope (it sees every
// change); other scopes publish order only, so dimming works but auto-unmark
// catches up once you're back in All changes.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "zeros:viewed-files:v1";

/** key (git target) → { path → file-hash captured when marked viewed } */
type ViewedMap = Record<string, Record<string, string>>;

const viewed: ViewedMap = load();
const order: Record<string, string[]> = {};
const curHash: Record<string, Record<string, string>> = {};
let version = 0;
const subscribers = new Set<() => void>();

function load(): ViewedMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as ViewedMap) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(viewed));
  } catch {
    /* quota — ignore */
  }
}
function emit(): void {
  version += 1;
  for (const cb of subscribers) cb();
}

/** FNV-1a 32-bit string hash → short base36. Cheap; only needs to CHANGE when
 *  content changes (not be cryptographic). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function isFileViewed(key: string, path: string): boolean {
  return !!viewed[key]?.[path];
}

/** Mark/unmark a file viewed. The hash defaults to the file's current published
 *  hash, so a later content change can auto-unmark it. */
export function setFileViewed(
  key: string,
  path: string,
  on: boolean,
  hash?: string,
): void {
  const m = viewed[key] ?? (viewed[key] = {});
  if (on) m[path] = hash ?? curHash[key]?.[path] ?? "";
  else delete m[path];
  persist();
  emit();
}

/** The current published hash for a file — the value to stamp when marking it
 *  viewed (so a later change of that file invalidates the mark). */
export function currentFileHash(key: string, path: string): string | undefined {
  return curHash[key]?.[path];
}

/** Published by the Changes view on each reload: the ordered change list + a
 *  per-file content hash. `full` = this is the COMPLETE change set (the "All
 *  changes" scope), so entries for paths no longer changed may be pruned. Always
 *  auto-unmarks entries whose hash changed (when a real hash is known). */
export function publishChanges(
  key: string,
  files: readonly { path: string; hash: string }[],
  full: boolean,
): void {
  order[key] = files.map((f) => f.path);
  const h: Record<string, string> = {};
  for (const f of files) h[f.path] = f.hash;
  curHash[key] = h;

  const vm = viewed[key];
  if (vm) {
    let changed = false;
    for (const p of Object.keys(vm)) {
      const cur = h[p];
      if (cur != null && cur !== "" && vm[p] !== "" && vm[p] !== cur) {
        delete vm[p]; // changed again → re-surface as unviewed
        changed = true;
      } else if (full && !(p in h)) {
        delete vm[p]; // no longer a change at all
        changed = true;
      }
    }
    if (changed) persist();
  }
  emit();
}

/** The next file to open after the current one is marked viewed / discarded.
 *  Continues DOWN from where you are — the first still-unviewed file AFTER the
 *  current one in list order (so reviewing #7 advances to #8, not back to #1).
 *  Only when nothing unviewed remains below does it wrap to the first unviewed
 *  from the top (to pick up any rows you skipped). null = nothing left → stay. */
export function nextUnviewedPath(key: string, currentPath: string): string | null {
  const list = order[key] ?? [];
  const i = list.indexOf(currentPath);
  // Forward from just after the current file (i = -1 when the current file is
  // gone, e.g. discarded → this starts at 0 = scan the whole list).
  for (let j = i + 1; j < list.length; j++) {
    if (!isFileViewed(key, list[j])) return list[j];
  }
  // Nothing unviewed below → wrap to the first unviewed from the top.
  for (const p of list) {
    if (p !== currentPath && !isFileViewed(key, p)) return p;
  }
  return null;
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Subscribe a component to viewed-state changes — re-renders on any mark /
 *  unmark / publish. The returned counter's value is unimportant. */
export function useViewedVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}
