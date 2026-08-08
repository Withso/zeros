// ──────────────────────────────────────────────────────────
// Conversation pane share-of-row math — pure helpers behind the seam drag
// ──────────────────────────────────────────────────────────
//
// Proportional columns (2026-07-17): conversation pane's size is a SHARE of the
// two-column row (0..1), not a pixel width — conversation pane grows by `ratio`
// and workbench by `1 - ratio` (via the shared `--zeros-column-2-ratio`
// variable), so window resizes and maximize are split between the two
// columns in proportion instead of flowing entirely into workbench.
//
// Kept as a leaf module (no component imports) so the clamp math is
// unit-testable without pulling in the chat tree.

/** The committed CSS variable both columns read for their grow factors.
 *  It is published on the two-column row after a drag and on <html> during
 *  boot. Live drag frames use direct `flex-grow` properties on the two flex
 *  items instead: inherited custom-property writes would invalidate style
 *  through every transcript, diff, iframe, and terminal descendant. */
export const CONVERSATION_RATIO_VAR = "--zeros-column-2-ratio";

// 50/50 default — a symmetric split matching the two-pane editor
// convention, and the split that reads best when a maximize doubles
// the row: both columns simply double.
export const CONVERSATION_RATIO_DEFAULT = 0.5;
// Storage-sanity bounds only — the real floors/caps are pixel-aware
// (CSS `min-w-[360px]` / `max-w-[min(2400px,70%)]` and the drag-time
// `clampConversationRatio`). 0.7 mirrors the CSS 70% cap so a persisted
// value never disagrees with what CSS would render.
export const CONVERSATION_RATIO_MIN = 0.1;
export const CONVERSATION_RATIO_MAX = 0.7;
/** Conversation pane's pixel floor — must match `min-w-[360px]` in
 *  CONVERSATION_DEFAULT_WIDTH_CLS (conversation/conversation-pane.tsx). */
export const CONVERSATION_MIN_PX = 360;
/** Conversation pane's pixel ceiling — must match the `2400px` leg of the CSS
 *  `max-w-[min(2400px,70%)]` cap. */
export const CONVERSATION_MAX_PX = 2400;
/** Workbench's pixel floor — must match `min-w-[200px]` in WORKBENCH_PANE_CLS
 *  (workbench/workbench-pane.tsx). The drag clamp reserves it so workbench never gets
 *  crushed mid-drag. */
export const WORKBENCH_MIN_PX = 200;

/** Marker attributes on the two columns of the conversation/workbench row.
 *  The split gate measures Workbench's live width through them (its slack above
 *  WORKBENCH_MIN_PX is the only room the conversation column can borrow), and
 *  the seam drag already targets column 3 by the same name. */
export const CONVERSATION_COLUMN_ATTR = "data-zeros-column-2";
export const WORKBENCH_COLUMN_ATTR = "data-zeros-column-3";

/** Where the ratio lives across launches. */
export const CONVERSATION_RATIO_KEY = "zeros.column2.ratio";
/** Pre-ratio installs persisted a pixel width here — migrated once
 *  (px ÷ window width ≈ share of the row) then removed. */
export const LEGACY_CONVERSATION_WIDTH_KEY = "zeros.column2.width";

/** Read the persisted share of the row, migrating the pixel-era value on
 *  first read. Lives HERE (not in the component) because the boot path
 *  writes the same value onto <html> before React's first render — see
 *  boot-layout-vars.ts. Two readers spelling the key or the clamp
 *  differently would disagree, and a disagreement is exactly the
 *  boot-time size animation the boot write exists to prevent. */
export function readPersistedConversationRatio(): number {
  if (typeof window === "undefined") return CONVERSATION_RATIO_DEFAULT;
  try {
    const raw = window.localStorage.getItem(CONVERSATION_RATIO_KEY);
    if (raw != null) return sanitizeConversationRatio(Number.parseFloat(raw));
    // One-time migration from the pixel era: the old value was conversation pane's
    // width in a row that spanned (approximately) the window, so
    // px ÷ innerWidth preserves the user's visual layout. Persist
    // immediately so the migration survives the reload that removes the
    // legacy key. (Idempotent under StrictMode's double initializer and
    // under the boot write + hook read: the second run reads the freshly
    // written key.)
    const legacy = window.localStorage.getItem(LEGACY_CONVERSATION_WIDTH_KEY);
    if (legacy != null) {
      window.localStorage.removeItem(LEGACY_CONVERSATION_WIDTH_KEY);
      const px = Number.parseInt(legacy, 10);
      if (Number.isFinite(px) && window.innerWidth > 0) {
        const migrated = sanitizeConversationRatio(px / window.innerWidth);
        window.localStorage.setItem(CONVERSATION_RATIO_KEY, String(migrated));
        return migrated;
      }
    }
  } catch {
    /* private mode / quota — fall through to default */
  }
  return CONVERSATION_RATIO_DEFAULT;
}

/** Store a committed ratio. Returns the clamped value actually stored so
 *  the caller's React state and the DOM can never diverge from it. */
export function persistConversationRatio(next: number): number {
  const clamped = sanitizeConversationRatio(next);
  try {
    window.localStorage.setItem(CONVERSATION_RATIO_KEY, String(clamped));
  } catch {
    /* persistence is best-effort */
  }
  return clamped;
}

/** Cancel and synchronously paint a queued seam-resize frame. Pointer-up can
 *  beat requestAnimationFrame; flushing keeps the DOM on the same ratio that
 *  will be persisted even when React bails out of an unchanged state update. */
export function flushPendingConversationRatioPaint(
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
export function sanitizeConversationRatio(value: number): number {
  if (!Number.isFinite(value)) return CONVERSATION_RATIO_DEFAULT;
  return Math.min(
    Math.max(value, CONVERSATION_RATIO_MIN),
    CONVERSATION_RATIO_MAX,
  );
}

/** Clamp a live drag ratio against the actual row width: conversation pane keeps
 *  its 360px floor and 2400px ceiling, workbench keeps its 200px floor,
 *  and the 70% share cap always applies. Mirrors the CSS
 *  `min-w`/`max-w` bounds exactly so the live drag matches what CSS
 *  renders — no snap on pointer release. The result always lands
 *  inside the sanitize bounds, so the value the drag paints is
 *  byte-identical to the value persist() will store — the two can
 *  never diverge, even on degenerate row widths. */
export function clampConversationRatio(
  raw: number,
  rowWidth: number,
  conversationMinPx = CONVERSATION_MIN_PX,
): number {
  if (!Number.isFinite(raw)) return CONVERSATION_RATIO_DEFAULT;
  const effectiveConversationMin =
    Number.isFinite(conversationMinPx) && conversationMinPx > 0
      ? conversationMinPx
      : CONVERSATION_MIN_PX;
  let min = CONVERSATION_RATIO_MIN;
  let max = CONVERSATION_RATIO_MAX;
  if (Number.isFinite(rowWidth) && rowWidth > 0) {
    min = Math.max(min, effectiveConversationMin / rowWidth);
    max = Math.min(
      max,
      (rowWidth - WORKBENCH_MIN_PX) / rowWidth,
      CONVERSATION_MAX_PX / rowWidth,
    );
  }
  // A row too narrow for both pixel floors: the grow factors stop
  // mattering (the CSS min-widths own the squeeze), so pin to the
  // persistable ceiling rather than a floor share the store would
  // re-clamp — keeps the live value persistable as-is.
  if (max < min) max = min;
  return sanitizeConversationRatio(Math.min(Math.max(raw, min), max));
}
