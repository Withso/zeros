// ──────────────────────────────────────────────────────────
// chat-scroll-anchor — element-anchored scroll positions for transcripts
// ──────────────────────────────────────────────────────────
//
// Why raw scrollTop is the wrong currency for the chat transcript: finalized
// turns render with `content-visibility: auto`, so any turn the browser deems
// off-screen — including EVERY turn while the chat layer is hidden
// (visibility:hidden deck layer, detached pane host, Home-route shell) — is
// laid out at its `contain-intrinsic-size` estimate instead of its real
// height. The transcript's scrollHeight therefore changes as turns collapse
// and re-expand, and a pixel offset measured against one layout lands
// somewhere else in the next (the "both chats shifted ~200px after a
// workspace round-trip" bug, 2026-07-21).
//
// The stable currency is WHICH TURN was at the top of the viewport plus the
// offset into it. Turn containers carry `data-checkpoint-id` (the user-prompt
// message id — persisted, stable across restarts), and they are the
// content-visibility boundaries, so measuring them never forces layout of a
// skipped turn's contents. Restoring scrolls the anchor turn back to the same
// viewport-relative offset; a couple of post-paint settle frames absorb the
// residual error while content-visibility re-renders the turns near the
// restored viewport at their true sizes.
//
// The raw `top` is still carried: it's the fallback when the anchor turn is
// gone (edit-truncated, paged out of the hydrate window) and the legacy
// format for pre-anchor saved values.

export interface ChatScrollPosition {
  /** Raw scrollTop px — fallback when the anchor can't be resolved, and the
   *  shape older builds persisted (a bare number normalizes to this). */
  top: number;
  /** `data-checkpoint-id` of the turn spanning the viewport top at save
   *  time. Absent when the viewport sat above the first turn. */
  anchorId?: string;
  /** Distance in px from the anchor turn's top to the viewport top (>= 0). */
  anchorOffset?: number;
  /** The reader was following the tail — restore means "the bottom", which
   *  may be lower than `top` if content streamed in while the chat was
   *  hidden or the app was closed. */
  atBottom?: boolean;
}

export interface ChatScrollCaptureState {
  /** Pre-detach registry capture may bypass the render-time active flag. */
  force: boolean;
  surfaceActive: boolean;
  restoreInProgress: boolean;
  connected: boolean;
  clientHeight: number;
  pendingHydrate: boolean;
}

/** One gate shared by compositor scroll events and synchronous pre-detach
 * capture. A correction/clamp frame is never allowed to become user memory. */
export function shouldCaptureChatScroll(
  state: ChatScrollCaptureState,
): boolean {
  if (state.restoreInProgress || state.pendingHydrate) return false;
  if (!state.force && !state.surfaceActive) return false;
  return state.connected && state.clientHeight > 0;
}

/** Saved `atBottom` means following live content. Blank checkpoint spacer
 * room is explicitly excluded even when it makes scrollTop reach maxScroll. */
export function isAtChatContentBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
  bottomInset,
  threshold = 32,
}: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  bottomInset: number;
  threshold?: number;
}): boolean {
  if (bottomInset > 0) return false;
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/** Accept anything previously persisted (bare number = legacy v1 shape,
 *  object = current shape) and return a sanitized position, or undefined
 *  when the value is unusable. */
export function normalizeChatScrollPosition(
  value: unknown,
): ChatScrollPosition | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? { top: value } : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.top !== "number" || !Number.isFinite(raw.top) || raw.top < 0) {
    return undefined;
  }
  const pos: ChatScrollPosition = { top: raw.top };
  if (typeof raw.anchorId === "string" && raw.anchorId.length > 0) {
    pos.anchorId = raw.anchorId;
    pos.anchorOffset =
      typeof raw.anchorOffset === "number" &&
      Number.isFinite(raw.anchorOffset) &&
      raw.anchorOffset >= 0
        ? raw.anchorOffset
        : 0;
  }
  if (raw.atBottom === true) pos.atBottom = true;
  return pos;
}

/** Value-equality for the store's no-op guard (scroll events fire per frame;
 *  identical positions must not churn subscribers or the persist debounce). */
export function sameChatScrollPosition(
  a: ChatScrollPosition | undefined,
  b: ChatScrollPosition | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.top === b.top &&
    a.anchorId === b.anchorId &&
    a.anchorOffset === b.anchorOffset &&
    a.atBottom === b.atBottom
  );
}

/** Minimal structural surface of the scroll container the measurement
 *  helpers need — lets node-env tests drive them with fakes. */
export interface AnchorScrollElement {
  scrollTop: number;
  getBoundingClientRect(): { top: number };
  querySelectorAll(selector: string): ArrayLike<AnchorTurnElement>;
  querySelector(selector: string): AnchorTurnElement | null;
}

export interface AnchorTurnElement {
  getBoundingClientRect(): { top: number };
  getAttribute(name: string): string | null;
}

const TURN_SELECTOR = "[data-checkpoint-id]";

/** Escape an id for use inside an attribute selector. CSS.escape when the
 *  platform provides it; a conservative quote/backslash escape otherwise
 *  (message ids are ASCII in practice). */
function escapeForSelector(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(id);
  }
  return id.replace(/["\\]/g, "\\$&");
}

/** The turn spanning the viewport top right now: the LAST turn whose top is
 *  at or above scrollTop (+1px layout-rounding tolerance). Returns undefined
 *  when the viewport sits above the first turn (leading system content). */
export function captureScrollAnchor(
  scrollEl: AnchorScrollElement,
): { anchorId: string; anchorOffset: number } | undefined {
  const containerTop = scrollEl.getBoundingClientRect().top;
  const scrollTop = scrollEl.scrollTop;
  let bestId: string | null = null;
  let bestTop = -Infinity;
  const turns = scrollEl.querySelectorAll(TURN_SELECTOR);
  for (let i = 0; i < turns.length; i += 1) {
    const el = turns[i];
    const id = el.getAttribute("data-checkpoint-id");
    if (!id) continue;
    const top = el.getBoundingClientRect().top - containerTop + scrollTop;
    if (top <= scrollTop + 1 && top > bestTop) {
      bestTop = top;
      bestId = id;
    }
  }
  if (bestId === null) return undefined;
  return { anchorId: bestId, anchorOffset: Math.max(0, scrollTop - bestTop) };
}

/** Content-relative top (scrollTop coordinate space) of the anchor turn, or
 *  null when it isn't in the DOM (truncated / outside the hydrate window). */
export function resolveAnchorTop(
  scrollEl: AnchorScrollElement,
  anchorId: string,
): number | null {
  const el = scrollEl.querySelector(
    `[data-checkpoint-id="${escapeForSelector(anchorId)}"]`,
  );
  if (!el) return null;
  return (
    el.getBoundingClientRect().top -
    scrollEl.getBoundingClientRect().top +
    scrollEl.scrollTop
  );
}

/** The scrollTop a restore should land at for `pos` in the CURRENT layout:
 *  the anchor turn's live position plus the saved offset, falling back to the
 *  raw px when the anchor is unresolvable. Re-run per settle frame — the
 *  anchor's measured top refines as content-visibility renders real sizes. */
export function restoreTargetTop(
  scrollEl: AnchorScrollElement,
  pos: ChatScrollPosition,
): number {
  if (pos.anchorId) {
    const anchorTop = resolveAnchorTop(scrollEl, pos.anchorId);
    if (anchorTop !== null) {
      return Math.max(0, anchorTop + (pos.anchorOffset ?? 0));
    }
  }
  return pos.top;
}
