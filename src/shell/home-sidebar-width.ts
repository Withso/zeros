// ──────────────────────────────────────────────────────────
// Home nav rail width — shared, persisted drag state
// ──────────────────────────────────────────────────────────
//
// The left Home rail (HomeSidebar) is resizable via a pointer-captured seam,
// the same gesture the col-2/col-3 seams use. Its width is ONE user
// preference (not per-surface state): every place the rail mounts reads this
// module store, so a drag is reflected everywhere and survives reloads via
// localStorage.
//
// Unlike the Files-tab sidebar — which persists a FRACTION so its sibling
// viewer scales proportionally — the Home rail's neighbor is a plain `flex-1`
// pane that simply absorbs the delta, so we persist a PIXEL width. Simpler,
// and the clamp is pure + exported for tests.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "zeros:home-sidebar-width:v1";

/** Fresh-install default — wider than the legacy 208px fixed rail so the
 *  Dashboard label, repo names, and the profile row breathe. */
export const HOME_SIDEBAR_DEFAULT_PX = 256;
/** Narrowest useful rail — repo names + the profile row stay readable. */
export const HOME_SIDEBAR_MIN_PX = 200;
/** Widest the rail may grow — keeps the content pane usable on laptops. */
export const HOME_SIDEBAR_MAX_PX = 420;

/** Clamp a raw width (px) into the rail's bounds; NaN falls back to default. */
export function clampHomeSidebarWidth(raw: number): number {
  if (!Number.isFinite(raw)) return HOME_SIDEBAR_DEFAULT_PX;
  return Math.min(Math.max(raw, HOME_SIDEBAR_MIN_PX), HOME_SIDEBAR_MAX_PX);
}

function load(): number {
  if (typeof window === "undefined") return HOME_SIDEBAR_DEFAULT_PX;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw != null) return clampHomeSidebarWidth(Number(raw));
  } catch {
    /* private mode / quota — fall through to default */
  }
  return HOME_SIDEBAR_DEFAULT_PX;
}

const listeners = new Set<() => void>();
let width = load();

/** Commit a drag result: clamp, publish to every mounted rail, and persist.
 *  Called on pointer release (not per move tick). */
export function setHomeSidebarWidth(value: number): void {
  const next = clampHomeSidebarWidth(value);
  if (next === width) return;
  width = next;
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    /* quota errors ignored */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): number {
  return width;
}

/** Reactive committed rail width (px) — render as `style={{ width }}`. */
export function useHomeSidebarWidth(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test-only reset for the module singleton. */
export function resetHomeSidebarWidthForTests(): void {
  width = HOME_SIDEBAR_DEFAULT_PX;
  listeners.clear();
}
