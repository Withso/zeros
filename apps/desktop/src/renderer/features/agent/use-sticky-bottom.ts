// ──────────────────────────────────────────────────────────
// useStickyBottom — chat-style auto-scroll with unstick
// ──────────────────────────────────────────────────────────
//
// Replaces unconditional `scrollTop = scrollHeight` updates with a bounded
// chat-following model that respects a user who has scrolled away from the end.
//
// Behavior:
//   - When the user is within `threshold` (default 32px) of
//     the bottom, new content auto-scrolls them to the new
//     bottom. Feels like the chat is following along.
//   - The moment they scroll up past that threshold, auto-
//     scroll disengages. They can read freely while content
//     keeps streaming below.
//   - When they scroll back to within threshold, it re-
//     engages. Returning to bottom always means "follow."
//
// The "is the user at bottom" decision is captured BEFORE
// React commits the next render — via useLayoutEffect plus
// a ref updated on every scroll event. Without this we'd
// have a race: new content lands, `scrollHeight` grows,
// distance-from-bottom suddenly exceeds threshold, and the
// hook would conclude "user is not at bottom" even though
// they hadn't moved. Capturing in a ref before the render
// (i.e. the scroll listener writes to the ref synchronously
// on the user's actual scroll, never on content growth)
// fixes this cleanly.
//
// Returns:
//   isAtBottom — for UI (jump-to-latest pill visibility)
//   jumpToBottom(smooth?) — for buttons + keybinds
// ──────────────────────────────────────────────────────────

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface StickyBottomState {
  /** True when the scroll position is within `threshold` of the
   *  bottom. Drives the visibility of the "Jump to latest" pill. */
  isAtBottom: boolean;
  /** Programmatic scroll-to-bottom. Used by the jump pill,
   *  Cmd+End keybind, and any "fresh chat opened" auto-snap. */
  jumpToBottom: (smooth?: boolean) => void;
}

export interface StickyBottomOptions {
  /** Distance-from-bottom in px below which we consider the user
   *  "at bottom" and auto-scroll on new content. Defaults to 32px.
   *  Smaller values feel pickier; larger values catch more
   *  partial-scroll cases. */
  threshold?: number;
  /** False while this chat is a hidden retained layer (workspace switched
   *  away, Home route). The transcript's turns use content-visibility:auto,
   *  so a hidden chat's layout COLLAPSES to intrinsic-size estimates — the
   *  browser clamps scrollTop and fires scroll/resize events that would
   *  otherwise overwrite stickRef/isAtBottom with garbage ("every hidden
   *  chat reads as at-bottom"). While disabled, measurement and the
   *  auto-snap both freeze; the pre-hide reading state survives untouched
   *  and re-measurement happens on re-enable (post-restore, post-paint). */
  enabled?: boolean;
  /** Seed for the at-bottom state before the first real measurement. A chat
   *  that mounts HIDDEN (intent-prepared view, background pane) is never
   *  measured until it's revealed, so the default `true` would mark a
   *  mid-transcript restore as a tail-follower and snap it to the bottom on
   *  the first content change after reveal. The consumer knows better: it
   *  seeds from the saved position's own atBottom flag. Read once at mount. */
  initialAtBottom?: boolean;
  /** The last N px of scrollHeight that are NOT content (2026-07-16):
   *  the checkpoint rail's bottom spacer — blank scroll room grown so
   *  a clicked user prompt can rest at the viewport top even when the
   *  content below it is shorter than a screen. While non-zero:
   *  - "bottom" means the CONTENT bottom (scrollHeight - inset), for
   *    both isAtBottom and jumpToBottom. A viewport parked inside the
   *    blank region reads as at-bottom (everything IS on screen), so
   *    the jump pill stays hidden — and stays hidden while streaming
   *    fills the blank, because the rail shrinks the spacer 1:1 with
   *    growth and the content-relative distance never goes positive
   *    until real content passes the fold.
   *  - the auto-snap is suspended entirely. The reader deliberately
   *    framed a checkpoint at the top; snapping into the blank would
   *    yank that framing on every stream chunk. The rail owns the
   *    viewport-stability contract for this window (maxScroll pinned
   *    to the checkpoint's target), and normal following resumes the
   *    moment the spacer is gone. */
  bottomInsetPx?: number;
}

/**
 * Hook the scroll container element directly and pass an array
 * of dependencies that mark "new content arrived" (typically
 * `[messages, status, pendingPermission]`). The effect runs on
 * each dep change and snaps to bottom only when the user was
 * at-or-near the bottom before the change.
 *
 * Pass the element via state-tracked callback ref (not RefObject)
 * so the hook re-runs once the element mounts. RefObjects don't
 * trigger re-renders when `.current` changes, which would leave
 * the hook permanently stuck on `null`.
 */
export function useStickyBottom(
  scrollEl: HTMLElement | null,
  contentDeps: unknown[],
  options: StickyBottomOptions = {},
): StickyBottomState {
  const threshold = options.threshold ?? 32;
  const enabled = options.enabled ?? true;
  /** Ref mirror so the content-change layout effect can honor the freeze
   *  without threading `enabled` through its dependency array. */
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [isAtBottom, setIsAtBottom] = useState(options.initialAtBottom ?? true);
  /** Mirror of isAtBottom kept in a ref so the layout-effect can
   *  read the user's pre-render intent without triggering an extra
   *  re-render of the hook's consumer. */
  const stickRef = useRef(options.initialAtBottom ?? true);
  /** Inset read through a ref everywhere: it changes on every spacer
   *  resize tick during streaming, and going through deps would tear
   *  down / re-subscribe the scroll listener + ResizeObserver each
   *  time (and re-mint jumpToBottom's identity). */
  const insetRef = useRef(options.bottomInsetPx ?? 0);
  insetRef.current = options.bottomInsetPx ?? 0;

  // Recompute "at bottom" on BOTH the user's scroll movement AND any
  // content/viewport size change. The size-change path is the one that's
  // easy to miss and the source of a real bug: collapsing an expanded tool
  // card (or any content SHRINK) reduces scrollHeight WITHOUT moving
  // scrollTop, so the browser fires no scroll event — leaving isAtBottom
  // stale at `false` and the jump-to-latest button stranded on-screen even
  // though the user is now flush against the bottom. Observing the resize
  // closes that gap; it also keeps the flag honest as tokens stream in,
  // images load, and the composer grows/shrinks the viewport. This mirrors
  // what the canonical use-stick-to-bottom lib (referenced by the
  // Conversation primitive) does, and what the sibling JumpToPromptPill
  // already does for its own visibility.
  useEffect(() => {
    if (!scrollEl || !enabled) return;
    const measure = () => {
      // A detached scroller (pane-host reparent mid-workspace-switch) or one
      // inside a display:none ancestor measures 0/0/0 — "at bottom" by the
      // arithmetic below, but it's not a reading position, it's the absence
      // of one. Skipping keeps stickRef honest across hide/reveal cycles so
      // the reattach restore doesn't mistake every hidden chat for a
      // tail-follower (the ResizeObserver fires with zero boxes on detach).
      if (scrollEl.clientHeight === 0 && scrollEl.scrollHeight === 0) return;
      // Content-relative distance: the inset region doesn't count as
      // "somewhere lower to go" (it can be NEGATIVE when the viewport
      // sits inside the blank region — unambiguously at-bottom).
      const distance =
        scrollEl.scrollHeight -
        insetRef.current -
        scrollEl.scrollTop -
        scrollEl.clientHeight;
      const atBottom = distance <= threshold;
      stickRef.current = atBottom;
      // Avoid setState if value unchanged — the hook's consumer
      // re-renders on this value, so spamming it on every wheel
      // tick during a freely-scrolling read is wasteful.
      setIsAtBottom((prev) => (prev === atBottom ? prev : atBottom));
    };
    scrollEl.addEventListener("scroll", measure, { passive: true });

    // A ResizeObserver on the scroll CONTAINER never fires on content-only
    // growth — its content-box is pinned by the flex layout. The element
    // that actually changes height when a tool card expands/collapses is
    // the content child (ConversationContent, flex-none), so observe that
    // too. Observing the container as well catches viewport resizes (the
    // composer growing, the column being dragged narrower). measure() only
    // reads layout + sets state and never mutates the observed boxes, so
    // there's no resize feedback loop.
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => measure());
      ro.observe(scrollEl);
      const content = scrollEl.firstElementChild;
      if (content) ro.observe(content);
    }

    // Run once so the initial state matches actual scroll position
    // (e.g. after a chat-switch hydrates messages and we land at
    // the bottom — without this the ref stays true regardless).
    measure();
    return () => {
      scrollEl.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [scrollEl, threshold, enabled]);

  // Snap to bottom on content change, but only when the user was
  // already there before the change. useLayoutEffect runs after
  // DOM mutation but before paint, so the user never sees the
  // intermediate "stuck above the new bottom" frame.
  //
  // First run is skipped — initial scroll position is the consumer's
  // responsibility (snap-to-bottom on chat-open OR restore from
  // per-chat scroll memory). Without this guard, mounting on a chat
  // with saved-scroll above bottom would cause a one-frame flash:
  // hook snaps to bottom → consumer's restore effect then jumps to
  // saved. Let the consumer own the initial position; the hook only
  // handles ongoing content-arrival.
  const firstContentRunRef = useRef(true);
  useLayoutEffect(() => {
    if (firstContentRunRef.current) {
      firstContentRunRef.current = false;
      return;
    }
    // Frozen while the chat is a hidden retained layer — a snap against the
    // content-visibility-collapsed layout would be wrong, and the reveal
    // path (reattach restore) owns the next position.
    if (!enabledRef.current) return;
    if (!stickRef.current) return;
    if (!scrollEl) return;
    // Snap suspended while a bottom inset is active — see the option
    // doc. (Following resumes automatically: once the inset is gone
    // the next content change lands here again.)
    if (insetRef.current > 0) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, contentDeps);

  const jumpToBottom = useCallback(
    (smooth = true) => {
      if (!scrollEl) return;
      // "Latest" is the CONTENT bottom — never the blank inset. The
      // explicit -clientHeight (instead of passing scrollHeight and
      // letting the browser clamp) is what makes the inset effective:
      // with a checkpoint spacer active this lands the answer's tail
      // flush with the viewport bottom, and the now-hidden spacer is
      // then collected by the rail's out-of-view rule. With inset 0 it
      // equals the old clamp target exactly.
      scrollEl.scrollTo({
        top: Math.max(
          0,
          scrollEl.scrollHeight - insetRef.current - scrollEl.clientHeight,
        ),
        behavior: smooth ? "smooth" : "auto",
      });
      // Force-stick after a programmatic jump — the user explicitly
      // asked to follow, even if they were unstuck before.
      stickRef.current = true;
      setIsAtBottom(true);
    },
    [scrollEl],
  );

  return { isAtBottom, jumpToBottom };
}

/**
 * Walk-by-text-message keybind helper. Returns the next
 * scroll target for `Cmd+Up` / `Cmd+Down` navigation that skips
 * over tool-call and thinking blocks — only user messages and the
 * agent's final-text bubbles count as "messages" worth jumping to.
 *
 * Usage:
 *   const target = nextTextMessageTarget(scrollEl, { direction: "up" });
 *   if (target !== null) scrollEl.scrollTo({ top: target, behavior: "smooth" });
 */
export function nextTextMessageTarget(
  scrollEl: HTMLElement,
  opts: { direction: "up" | "down"; selector?: string },
): number | null {
  // Walk only user prompts and final agent text. Thinking
  // and tool blocks are deliberately skipped so a 30-min run with
  // 200 cards is one keystroke per actual back-and-forth, not 200.
  // The class is `zeros-agent-msg-agent` after the assistant→agent
  // rename; the older `-msg-assistant` selector silently matched
  // nothing since that class was never emitted, which made the
  // keybind feel like it only navigated user prompts.
  const selector =
    opts.selector ?? ".zeros-agent-msg-user, .zeros-agent-msg-agent";
  const elements = Array.from(scrollEl.querySelectorAll<HTMLElement>(selector));
  if (elements.length === 0) return null;

  const containerRect = scrollEl.getBoundingClientRect();
  const offsetTops = elements.map(
    (el) =>
      el.getBoundingClientRect().top - containerRect.top + scrollEl.scrollTop,
  );

  const currentTop = scrollEl.scrollTop;

  if (opts.direction === "up") {
    // Largest offsetTop strictly less than currentTop minus a small
    // fudge so "jumping to the message you're already at the top of"
    // moves you to the previous one. 8px ≈ chrome padding.
    const candidates = offsetTops.filter((t) => t < currentTop - 8);
    if (candidates.length === 0) return 0; // already at top — go to start
    return Math.max(...candidates);
  }

  // direction === "down"
  const candidates = offsetTops.filter((t) => t > currentTop + 8);
  if (candidates.length === 0) {
    // No more messages below — return the absolute bottom so callers
    // can `scrollTo({ top: bottom })` and engage the sticky-bottom path.
    return scrollEl.scrollHeight;
  }
  return Math.min(...candidates);
}
