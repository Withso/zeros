// ──────────────────────────────────────────────────────────
// Files-tab sidebar width — shared, persisted drag state
// ──────────────────────────────────────────────────────────
//
// The row-1 File tab's file-tree sidebar is resizable (a pointer-captured
// seam, like the col-2/col-3 seam). Its width is ONE user preference,
// not per-tab state: every File tab (including a dirty tab kept mounted
// invisibly) reads the same module store, so dragging in one tab is
// reflected everywhere and survives reloads via localStorage.
//
// Proportional columns (2026-07-17): the preference is a FRACTION of the
// two-pane container (rendered as a percentage width), not a pixel width —
// so when column 3 itself resizes (seam drag, window resize, maximize) the
// sidebar and the viewer share the delta proportionally instead of the
// viewer absorbing all of it.
//
// The clamp is pure and exported for tests: the sidebar never shrinks under
// its usable pixel floor, and always leaves the viewer a working column — in
// a column too narrow for both, the sidebar floor wins and flex handles the
// squeeze (mirrors how the original two-pane Files tab behaved).

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "zeros:files-sidebar-fraction:v1";
/** Pre-fraction installs persisted a pixel width here — migrated once
 *  (px ÷ a nominal column width) then removed. */
const LEGACY_PX_STORAGE_KEY = "zeros:files-sidebar-width:v1";
/** Reference column width for the one-time px→fraction migration — the
 *  ballpark of column 3 on a laptop window, so a migrated layout lands
 *  close to what the user had. */
const LEGACY_MIGRATION_REFERENCE_PX = 800;

/** Narrowest useful tree column (rows + filter bar stay readable). Must
 *  match the sidebar's `min-w-[140px]` class at both render sites. */
export const FILES_SIDEBAR_MIN_PX = 140;
/** Fresh-install default — ~240px in a laptop-sized column 3. */
export const FILES_SIDEBAR_DEFAULT_FRACTION = 0.3;
/** The viewer keeps at least this much; the drag clamp reserves it. */
export const FILES_VIEWER_MIN_PX = 220;
/** Share ceiling — must match the sidebar's `max-w-[70%]` class, so the
 *  live drag never exceeds what CSS would render. */
export const FILES_SIDEBAR_MAX_FRACTION = 0.7;
/** Storage-sanity floor only — the render-time pixel floor is the CSS
 *  `min-w-[140px]`; this just keeps persisted garbage out of the store. */
export const FILES_SIDEBAR_MIN_FRACTION = 0.02;

/** Clamp a live drag width (px) against the tab's current width: at least
 *  the sidebar floor, at most what leaves the viewer its minimum column
 *  (never below the floor itself when the tab is very narrow). */
export function clampFilesSidebarWidth(
  raw: number,
  containerWidth: number,
): number {
  const max = Math.max(
    FILES_SIDEBAR_MIN_PX,
    containerWidth - FILES_VIEWER_MIN_PX,
  );
  return Math.min(Math.max(raw, FILES_SIDEBAR_MIN_PX), max);
}

/** Convert a live drag position (px from the container's left edge) into
 *  the fraction the store persists: pixel-clamped first (sidebar floor +
 *  viewer reservation), then capped at the CSS `max-w-[70%]` share so the
 *  live width always equals what CSS renders — no snap-back on release. */
export function clampFilesSidebarFraction(
  rawPx: number,
  containerWidth: number,
): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return FILES_SIDEBAR_DEFAULT_FRACTION;
  }
  const px = clampFilesSidebarWidth(rawPx, containerWidth);
  return Math.min(px / containerWidth, FILES_SIDEBAR_MAX_FRACTION);
}

/** Sanitize a persisted (or just-dragged) fraction into the global bounds. */
export function sanitizeFilesSidebarFraction(value: number): number {
  if (!Number.isFinite(value)) return FILES_SIDEBAR_DEFAULT_FRACTION;
  return Math.min(
    Math.max(value, FILES_SIDEBAR_MIN_FRACTION),
    FILES_SIDEBAR_MAX_FRACTION,
  );
}

function load(): number {
  if (typeof window === "undefined") return FILES_SIDEBAR_DEFAULT_FRACTION;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw != null) return sanitizeFilesSidebarFraction(Number(raw));
    // One-time migration from the pixel era. The old px value has no
    // container to divide by at module load, so a nominal laptop-sized
    // column stands in — monotone (a wider saved sidebar migrates to a
    // wider share), which is what the preference actually encoded.
    const legacy = localStorage.getItem(LEGACY_PX_STORAGE_KEY);
    if (legacy != null) {
      localStorage.removeItem(LEGACY_PX_STORAGE_KEY);
      const px = Number(legacy);
      if (Number.isFinite(px) && px > 0) {
        const migrated = sanitizeFilesSidebarFraction(
          px / LEGACY_MIGRATION_REFERENCE_PX,
        );
        localStorage.setItem(STORAGE_KEY, String(migrated));
        return migrated;
      }
    }
  } catch {
    /* private mode / quota — fall through to default */
  }
  return FILES_SIDEBAR_DEFAULT_FRACTION;
}

const listeners = new Set<() => void>();
let fraction = load();

/** Commit a drag result: sanitize, publish to every mounted Files tab, and
 *  persist. Called on pointer release (not per move tick). */
export function setFilesSidebarFraction(value: number): void {
  const next = sanitizeFilesSidebarFraction(value);
  if (next === fraction) return;
  fraction = next;
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
  return fraction;
}

/** Reactive committed sidebar fraction (0..1) for the Files tab's left
 *  pane — render as a percentage width so it scales with the column. */
export function useFilesSidebarFraction(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test-only reset for the module singleton. */
export function resetFilesSidebarFractionForTests(): void {
  fraction = FILES_SIDEBAR_DEFAULT_FRACTION;
  listeners.clear();
}
