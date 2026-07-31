// ──────────────────────────────────────────────────────────
// Column 2 share-of-row math — pure helpers behind the seam drag
// ──────────────────────────────────────────────────────────
//
// Proportional columns (2026-07-17): col 2's size is a SHARE of the
// two-column row (0..1), not a pixel width — col 2 grows by `ratio`
// and col 3 by `1 - ratio` (via the shared `--zeros-column-2-ratio`
// variable), so window resizes and maximize are split between the two
// columns in proportion instead of flowing entirely into col 3.
//
// Kept as a leaf module (no component imports) so the clamp math is
// unit-testable without pulling in the chat tree.

/** The shared CSS variable both columns read for their grow factors.
 *  Set on the two-column ROW element (not :root) — scoping the write
 *  keeps per-frame drag updates from invalidating style for the whole
 *  document (inherited custom properties recalc every descendant of
 *  the element they're set on). Same pattern as the terminal panel's
 *  TERMINAL_PANEL_HEIGHT_VAR. */
export const COLUMN_2_RATIO_VAR = "--zeros-column-2-ratio";

// 50/50 default — a symmetric split matching the two-pane editor
// convention, and the split that reads best when a maximize doubles
// the row: both columns simply double.
export const COLUMN_2_RATIO_DEFAULT = 0.5;
// Storage-sanity bounds only — the real floors/caps are pixel-aware
// (CSS `min-w-[320px]` / `max-w-[min(2400px,70%)]` and the drag-time
// `clampColumn2Ratio`). 0.7 mirrors the CSS 70% cap so a persisted
// value never disagrees with what CSS would render.
export const COLUMN_2_RATIO_MIN = 0.1;
export const COLUMN_2_RATIO_MAX = 0.7;
/** Col 2's pixel floor — must match `min-w-[320px]` in
 *  COL2_DEFAULT_WIDTH_CLS (column2-workspace.tsx). */
export const COLUMN_2_MIN_PX = 320;
/** Col 2's pixel ceiling — must match the `2400px` leg of the CSS
 *  `max-w-[min(2400px,70%)]` cap. */
export const COLUMN_2_MAX_PX = 2400;
/** Col 3's pixel floor — must match `min-w-[200px]` in COL3_CLS
 *  (column3.tsx). The drag clamp reserves it so col 3 never gets
 *  crushed mid-drag. */
export const COLUMN_3_MIN_PX = 200;

/** Where the ratio lives across launches. */
export const COLUMN_2_RATIO_KEY = "zeros.column2.ratio";
/** Pre-ratio installs persisted a pixel width here — migrated once
 *  (px ÷ window width ≈ share of the row) then removed. */
export const COLUMN_2_LEGACY_WIDTH_KEY = "zeros.column2.width";

/** Read the persisted share of the row, migrating the pixel-era value on
 *  first read. Lives HERE (not in the component) because the boot path
 *  writes the same value onto <html> before React's first render — see
 *  boot-layout-vars.ts. Two readers spelling the key or the clamp
 *  differently would disagree, and a disagreement is exactly the
 *  boot-time size animation the boot write exists to prevent. */
export function readPersistedColumn2Ratio(): number {
  if (typeof window === "undefined") return COLUMN_2_RATIO_DEFAULT;
  try {
    const raw = window.localStorage.getItem(COLUMN_2_RATIO_KEY);
    if (raw != null) return sanitizeColumn2Ratio(Number.parseFloat(raw));
    // One-time migration from the pixel era: the old value was col 2's
    // width in a row that spanned (approximately) the window, so
    // px ÷ innerWidth preserves the user's visual layout. Persist
    // immediately so the migration survives the reload that removes the
    // legacy key. (Idempotent under StrictMode's double initializer and
    // under the boot write + hook read: the second run reads the freshly
    // written key.)
    const legacy = window.localStorage.getItem(COLUMN_2_LEGACY_WIDTH_KEY);
    if (legacy != null) {
      window.localStorage.removeItem(COLUMN_2_LEGACY_WIDTH_KEY);
      const px = Number.parseInt(legacy, 10);
      if (Number.isFinite(px) && window.innerWidth > 0) {
        const migrated = sanitizeColumn2Ratio(px / window.innerWidth);
        window.localStorage.setItem(COLUMN_2_RATIO_KEY, String(migrated));
        return migrated;
      }
    }
  } catch {
    /* private mode / quota — fall through to default */
  }
  return COLUMN_2_RATIO_DEFAULT;
}

/** Store a committed ratio. Returns the clamped value actually stored so
 *  the caller's React state and the DOM can never diverge from it. */
export function persistColumn2Ratio(next: number): number {
  const clamped = sanitizeColumn2Ratio(next);
  try {
    window.localStorage.setItem(COLUMN_2_RATIO_KEY, String(clamped));
  } catch {
    /* persistence is best-effort */
  }
  return clamped;
}

/** Cancel and synchronously paint a queued seam-resize frame. Pointer-up can
 *  beat requestAnimationFrame; flushing keeps the DOM on the same ratio that
 *  will be persisted even when React bails out of an unchanged state update. */
export function flushPendingColumn2RatioPaint(
  frameId: number | null,
  cancelFrame: (frameId: number) => void,
  paint: () => void,
): boolean {
  if (frameId === null) return false;
  cancelFrame(frameId);
  paint();
  return true;
}

/** Clamp a persisted (or just-computed) ratio into the global bounds. */
export function sanitizeColumn2Ratio(value: number): number {
  if (!Number.isFinite(value)) return COLUMN_2_RATIO_DEFAULT;
  return Math.min(Math.max(value, COLUMN_2_RATIO_MIN), COLUMN_2_RATIO_MAX);
}

/** Clamp a live drag ratio against the actual row width: col 2 keeps
 *  its 320px floor and 2400px ceiling, col 3 keeps its 200px floor,
 *  and the 70% share cap always applies. Mirrors the CSS
 *  `min-w`/`max-w` bounds exactly so the live drag matches what CSS
 *  renders — no snap on pointer release. The result always lands
 *  inside the sanitize bounds, so the value the drag paints is
 *  byte-identical to the value persist() will store — the two can
 *  never diverge, even on degenerate row widths. */
export function clampColumn2Ratio(raw: number, rowWidth: number): number {
  if (!Number.isFinite(raw)) return COLUMN_2_RATIO_DEFAULT;
  let min = COLUMN_2_RATIO_MIN;
  let max = COLUMN_2_RATIO_MAX;
  if (Number.isFinite(rowWidth) && rowWidth > 0) {
    min = Math.max(min, COLUMN_2_MIN_PX / rowWidth);
    max = Math.min(
      max,
      (rowWidth - COLUMN_3_MIN_PX) / rowWidth,
      COLUMN_2_MAX_PX / rowWidth,
    );
  }
  // A row too narrow for both pixel floors: the grow factors stop
  // mattering (the CSS min-widths own the squeeze), so pin to the
  // persistable ceiling rather than a floor share the store would
  // re-clamp — keeps the live value persistable as-is.
  if (max < min) max = min;
  return sanitizeColumn2Ratio(Math.min(Math.max(raw, min), max));
}
