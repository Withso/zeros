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
// Keep reader intent separate from transient layout and smooth-scroll
// geometry. React content updates and asynchronous layout both follow the
// tail; a reader gesture cancels that following immediately. A latest jump
// retains its destination through intermediate scroll events, then resolves
// the current bottom when the native animation ends.
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

import { beginChatScrollNavigation, CHAT_SCROLL_NAVIGATION_EVENT, type ChatScrollNavigation } from "./chat-scroll-navigation";

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

  // Native smooth scrolling emits intermediate scroll events. They describe
  // animation progress, not a reader leaving the tail. Keep that intent until
  // scrollend, then resolve the latest geometry (which may have changed).
  const jumpingRef = useRef(false);
  const readingNavigationRef = useRef(false);
  const readingTargetRef = useRef<number | undefined>(undefined);
  const cancelJumpRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!scrollEl || !enabled) return;
    let lastHeight = scrollEl.scrollHeight;
    let lastViewport = scrollEl.clientHeight;
    const measure = (resized = false) => {
      if (!enabledRef.current || scrollEl.clientHeight === 0) return;
      const geometryChanged =
        lastHeight !== scrollEl.scrollHeight ||
        lastViewport !== scrollEl.clientHeight;
      // Text smoothing, image decoding and content-visibility layout happen
      // after React's content effect. Follow these resizes too, without
      // treating them as reader scrolls. A user gesture clears stickRef first.
      if (
        (resized || geometryChanged) && stickRef.current &&
        !jumpingRef.current && insetRef.current === 0
      ) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
      lastHeight = scrollEl.scrollHeight;
      lastViewport = scrollEl.clientHeight;
      const atBottom =
        scrollEl.scrollHeight - insetRef.current - scrollEl.scrollTop -
        scrollEl.clientHeight <= threshold;
      // Scrollend can still belong to the navigation we just interrupted.
      // Release reading suppression on actual departure or arrival at its
      // intended target. Checkpoint blank space separately suspends snapping.
      const readingTarget = readingTargetRef.current;
      const reachedReadingTarget = readingTarget !== undefined && Math.abs(
        scrollEl.scrollTop - Math.max(0, Math.min(readingTarget, scrollEl.scrollHeight - scrollEl.clientHeight)),
      ) <= 1;
      const enteringCheckpointTail = insetRef.current > 0 && readingTarget !== undefined &&
        readingTarget >= scrollEl.scrollHeight - insetRef.current - scrollEl.clientHeight;
      if (readingNavigationRef.current && (!atBottom || enteringCheckpointTail || reachedReadingTarget)) {
        readingNavigationRef.current = false;
      }
      // A single layout burst can outgrow the remaining checkpoint blank
      // space before the rail commits its smaller inset. Retain following
      // through that resize; the first zero-inset pass can catch up.
      const awaitingSpacerResize = stickRef.current && insetRef.current > 0 &&
        (resized || geometryChanged);
      if (!jumpingRef.current && !readingNavigationRef.current && !awaitingSpacerResize) {
        stickRef.current = atBottom;
      }
      setIsAtBottom((prev) => (prev === atBottom ? prev : atBottom));
    };
    let gestureFrame = 0;
    const onScroll = () => measure();
    const onGesture = () => {
      cancelJumpRef.current();
      if (readingNavigationRef.current) {
        scrollEl.scrollTo({ top: scrollEl.scrollTop, behavior: "instant" });
      }
      readingNavigationRef.current = false;
      stickRef.current = false;
      // A click or a downward wheel at the very end may not emit scroll.
      // Re-measure after the browser/React handles the gesture so following
      // does not remain disabled when the reader never actually moved away.
      if (gestureFrame) cancelAnimationFrame(gestureFrame);
      gestureFrame = requestAnimationFrame(() => {
        gestureFrame = 0;
        measure();
      });
    };
    const onNavigation = (event: Event) => {
      cancelJumpRef.current();
      const { follow = false, target } = (event as CustomEvent<ChatScrollNavigation>).detail ?? {};
      readingTargetRef.current = target;
      readingNavigationRef.current = !follow;
      stickRef.current = follow;
      // A navigation can spend its first frame at the old bottom. Unlike a
      // no-motion gesture, it must not re-arm following before it moves.
      if (gestureFrame) cancelAnimationFrame(gestureFrame);
      gestureFrame = 0;
      if (!follow) measure();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Enter"].includes(event.key)) {
        onGesture();
      }
    };
    scrollEl.addEventListener(CHAT_SCROLL_NAVIGATION_EVENT, onNavigation);
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    scrollEl.addEventListener("wheel", onGesture, { passive: true });
    scrollEl.addEventListener("touchstart", onGesture, { passive: true });
    scrollEl.addEventListener("pointerdown", onGesture, { passive: true });
    scrollEl.addEventListener("click", onGesture, { passive: true });
    scrollEl.addEventListener("keydown", onKeyDown);
    const ro = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => measure(true));
    ro?.observe(scrollEl);
    const content = scrollEl.firstElementChild;
    if (content) ro?.observe(content);
    measure();
    return () => {
      cancelJumpRef.current();
      if (gestureFrame) cancelAnimationFrame(gestureFrame);
      readingNavigationRef.current = false;
      scrollEl.removeEventListener(CHAT_SCROLL_NAVIGATION_EVENT, onNavigation);
      scrollEl.removeEventListener("scroll", onScroll);
      scrollEl.removeEventListener("wheel", onGesture);
      scrollEl.removeEventListener("touchstart", onGesture);
      scrollEl.removeEventListener("pointerdown", onGesture);
      scrollEl.removeEventListener("click", onGesture);
      scrollEl.removeEventListener("keydown", onKeyDown);
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
    if (!stickRef.current || jumpingRef.current) return;
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
      if (!scrollEl || !enabledRef.current || scrollEl.clientHeight === 0) return;
      beginChatScrollNavigation(scrollEl, { follow: true });
      cancelJumpRef.current();
      readingNavigationRef.current = false;
      const target = () => Math.max(
        0, scrollEl.scrollHeight - insetRef.current - scrollEl.clientHeight,
      );
      const finish = () => {
        scrollEl.removeEventListener("scrollend", finish);
        cancelJumpRef.current = () => {};
        jumpingRef.current = false;
        if (!enabledRef.current || scrollEl.clientHeight === 0) return;
        scrollEl.scrollTo({ top: target(), behavior: "instant" });
        stickRef.current = true;
        setIsAtBottom(true);
      };
      stickRef.current = true;
      if (
        !smooth || Math.abs(scrollEl.scrollTop - target()) <= 1 ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        finish();
        return;
      }
      jumpingRef.current = true;
      scrollEl.addEventListener("scrollend", finish);
      cancelJumpRef.current = () => {
        scrollEl.removeEventListener("scrollend", finish);
        cancelJumpRef.current = () => {};
        jumpingRef.current = false;
        // Stop the browser animation as well as our eventual correction.
        scrollEl.scrollTo({ top: scrollEl.scrollTop, behavior: "instant" });
      };
      scrollEl.scrollTo({ top: target(), behavior: "smooth" });
      // isAtBottom describes actual geometry, not the destination. Publishing
      // true here would let AgentChat trim paged history during the animation.
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
