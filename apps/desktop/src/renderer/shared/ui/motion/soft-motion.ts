// The live tail's motion language: nothing travels. Things are at their new
// place at once; a soft dissolve (opacity, a few pixels of offset and a hint
// of blur while moving) marks new content, and a capped settle over the last
// few pixels hints at the direction of a move without showing it. Transform,
// opacity and filter only; Web Animations, so a new change continues from the
// current visual state instead of restarting.

import { useCallback, useRef } from "react";

/** One gentle ease-out for every motion, no overshoot. Cubic rather than the
 * steeper quint-like curve, so a glide's first frame moves ~15% of the way
 * (about 5px of a 36px glide) instead of ~25%. */
export const SOFT_EASE = "cubic-bezier(0.33, 1, 0.68, 1)";
export const SOFT_ENTER_MS = 340;
export const SOFT_EXIT_MS = 260;
/** The enter starts this soon, so the swap reads as one dissolve: with this
 * ease the two labels' opacities never sum below 0.46 (the line never looks
 * empty) and never both exceed 0.26 (they never read as text on text). */
export const SOFT_ENTER_DELAY_MS = 60;
/** No element is ever drawn further than this from its layout position. A
 * move is shown as being at the new place, settling the last few pixels. */
export const SOFT_SETTLE_CAP_PX = 5;
export const SOFT_SETTLE_MS = 220;
/** Reduced motion keeps a short opacity fade and nothing else. */
const REDUCED_FADE_MS = 120;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** No animation work for a hidden tab or a hidden retained surface. */
function canAnimate(el: Element): boolean {
  return typeof el.animate === "function" && document.visibilityState !== "hidden" &&
    (el as HTMLElement).offsetParent !== null;
}

export interface SoftOptions {
  /** Small elements only (labels, headers, the timer). */
  blur?: boolean;
  delay?: number;
  /** Signed start offset in px: positive rises from below (the default),
   * negative comes down from above (content that appears lower), 0 none. */
  travel?: number;
}

/** Opacity carries a change; travel and blur are only hints of it. */
export const SOFT_ENTER_TRAVEL_PX = 4;
export const SOFT_ENTER_BLUR_PX = 1.5;
/** Exits only fade: an offset on what is leaving would add to the settle of
 * what holds it and could draw it past the cap. */
export const SOFT_EXIT_TRAVEL_PX = 0;
export const SOFT_EXIT_BLUR_PX = 1;

/** Dissolve in: opacity 0 → 1, 4px → 0, and blur 1.5px → 0 when allowed. */
export function softEnter(el: HTMLElement, { blur = true, delay = 0, travel = SOFT_ENTER_TRAVEL_PX }: SoftOptions = {}): Animation | null {
  if (!canAnimate(el)) return null;
  if (prefersReducedMotion())
    return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REDUCED_FADE_MS, delay, fill: "backwards" });
  return el.animate([
    { opacity: 0, transform: `translateY(${travel}px)`, filter: blur ? `blur(${SOFT_ENTER_BLUR_PX}px)` : "none" },
    { opacity: 1, transform: "none", filter: blur ? "blur(0px)" : "none" },
  ], { duration: SOFT_ENTER_MS, delay, easing: SOFT_EASE, fill: "backwards" });
}

/** Dissolve out from wherever the element is now (mid-enter included):
 * opacity → 0, blur → 1px, no travel. The element stays at its final frame. */
export function softExit(el: HTMLElement, { blur = true }: SoftOptions = {}): Animation | null {
  if (!canAnimate(el)) return null;
  const now = getComputedStyle(el);
  const from = { opacity: Number(now.opacity), transform: now.transform, filter: now.filter };
  for (const animation of el.getAnimations()) animation.cancel();
  if (prefersReducedMotion())
    return el.animate([{ opacity: from.opacity }, { opacity: 0 }], { duration: REDUCED_FADE_MS, fill: "forwards" });
  return el.animate([
    from,
    { opacity: 0, transform: SOFT_EXIT_TRAVEL_PX ? `${from.transform === "none" ? "" : from.transform} translateY(-${SOFT_EXIT_TRAVEL_PX}px)`.trim() : from.transform, filter: blur ? `blur(${SOFT_EXIT_BLUR_PX}px)` : "none" },
  ], { duration: SOFT_EXIT_MS, easing: SOFT_EASE, fill: "forwards" });
}

/** A ref that dissolves its element in the first time it mounts after its
 * owner rendered without it (a description that arrives later); never on
 * load, and only once. */
export function useSoftAppear(present: boolean, options?: SoftOptions): (el: HTMLElement | null) => void {
  const absentAtStart = useRef(!present);
  return useCallback((el: HTMLElement | null) => {
    if (!el || !absentAtStart.current) return;
    absentAtStart.current = false;
    softEnter(el, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ── FLIP glides ───────────────────────────────────────────

/** Where the element sits, two ways: its offset inside its container, and
 * its distance from the bottom of the scroll content. */
export interface GlideMark {
  inContainer: number;
  toBottom: number;
}

/** The translateY that puts the element back where the user last saw it.
 * When the scroller follows the tail (the chat pinned to its bottom, or a
 * transcript too short to scroll), the screen keeps the content's bottom in
 * place, so only a change in the distance to that bottom is a move: a tail
 * that grows stays put and gets 0. Otherwise the container is held where it
 * was (content above it did not change in this layout), so the move is the
 * change inside the container minus any scroll the browser applied for this
 * layout (`scrolled`, e.g. scroll anchoring). */
export function glideOffset(previous: GlideMark, next: GlideMark, follows: boolean, scrolled = 0): number {
  if (follows) return next.toBottom - previous.toBottom;
  return scrolled - (next.inContainer - previous.inContainer);
}

/** Where a settle starts: the current drawn offset plus the new move, but
 * never further than the cap. A further move mid-settle continues from where
 * the element is drawn and never accumulates beyond the cap. */
export function settleFrom(currentOffset: number, offset: number): number {
  return Math.max(-SOFT_SETTLE_CAP_PX, Math.min(SOFT_SETTLE_CAP_PX, currentOffset + offset));
}

function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/** Glides move the separate `translate` property, so they compose with a
 * dissolve's `transform` on the same element instead of replacing it. */
function translateYOf(el: HTMLElement): number {
  const translate = getComputedStyle(el).translate;
  if (!translate || translate === "none") return 0;
  return parseFloat(translate.split(" ")[1] ?? "0") || 0;
}

/** A followed tail that grew: the scroller snapped, so the content above the
 * element moved up on screen. Glide the content from where it was (`content`,
 * px down) and counter the element by `line`, so the element itself only
 * moves if it really moved on screen (a transcript too short to scroll).
 * `content + line` is the element's own screen move, which is 0 when the
 * scroller absorbed all of the growth. */
export function followGlide(previous: GlideMark, next: GlideMark): { content: number; line: number } {
  const growth = next.inContainer - previous.inContainer;
  const lineMove = previous.toBottom - next.toBottom;
  return { content: growth - lineMove, line: -growth };
}

/** The live glide on a scroller's content, so code that measures rows with
 * getBoundingClientRect (the checkpoint rail, scroll anchors) reads layout,
 * not the motion. 0 at rest, without reading style. */
export function contentGlideOf(scrollEl: { firstElementChild?: Element | null }): number {
  const content = scrollEl.firstElementChild as HTMLElement | null | undefined;
  return content?.dataset?.gliding === undefined ? 0 : translateYOf(content);
}

/** The scroller's height in layout. A content glide displaces the content
 * down, and transforms count toward scrollable overflow: following the raw
 * scrollHeight mid-glide would scroll to that displaced edge and undo the
 * glide. Pin and "at bottom" checks read this instead. */
export function layoutScrollHeight(scrollEl: { scrollHeight: number; firstElementChild?: Element | null }): number {
  return scrollEl.scrollHeight - Math.max(0, contentGlideOf(scrollEl));
}

/** One element's translate glide: set inline at once, then eased to rest. */
function slider(el: HTMLElement, marker?: string, onStop?: () => void) {
  let running: Animation | null = null;
  const stop = () => {
    running?.cancel();
    running = null;
    el.style.translate = "";
    if (marker) delete el.dataset[marker];
    onStop?.();
  };
  return {
    // The marker also covers a glide another controller started (a new turn's
    // line taking over the same transcript content).
    current: () => (marker ? el.dataset[marker] !== undefined : running) ? translateYOf(el) : 0,
    stop,
    /** `from` is the absolute start; a running glide is replaced from there. */
    start(from: number) {
      running?.cancel();
      if (Math.abs(from) < 0.5) {
        stop();
        return;
      }
      // Inline first: an animation started after this frame's animation update
      // only applies from the next frame.
      el.style.translate = `0 ${from}px`;
      if (marker) el.dataset[marker] = "";
      const glide = el.animate([{ translate: `0 ${from}px` }, { translate: "0 0" }],
        { duration: SOFT_SETTLE_MS, easing: SOFT_EASE, fill: "forwards" });
      running = glide;
      glide.onfinish = () => {
        if (running === glide) stop();
      };
    },
  };
}

/** Dispatched (bubbling) by agent-caused growth at the live tail that no
 * commit of the turn announces, e.g. a streaming message's newly shown text. */
export const TAIL_GROWTH_EVENT = "zeros-tail-growth";

/** A reader's pointer or key input this recently owns the next layout change. */
export const READER_INPUT_WINDOW_MS = 200;

/** Whether a layout change may glide. Only growth the agent caused at the
 * live tail travels; anything else (a disclosure the reader toggled, show
 * more, a resize, zoom, fonts) just is in its new place. A reader input in
 * the same moment as agent growth also resolves to no motion. */
export function glideAttribution({ agentGrowth, sinceReaderInputMs, resized, readerOwned = false }: {
  agentGrowth: boolean;
  sinceReaderInputMs: number;
  resized: boolean;
  /** The reader opened the live tail group: what grows inside it is theirs
   * to read, so it simply appears in place. */
  readerOwned?: boolean;
}): "glide" | "silent" {
  if (resized || readerOwned || !agentGrowth || sinceReaderInputMs < READER_INPUT_WINDOW_MS) return "silent";
  return "glide";
}

const READER_INPUTS = ["pointerdown", "click", "keydown", "wheel", "touchstart"];

export interface Glide {
  /** Take the next layout change as the new resting place, without motion. */
  settle(): void;
  /** The next layout change comes from agent growth at the tail. */
  grew(): void;
  /** The reader opened the live tail group (see glideAttribution). */
  readerOwns(owned: boolean): void;
  /** End every glide at once (the turn ended): nothing keeps travelling. */
  dispose(): void;
}

/** Settle `el` (the live turn's loader line) when a layout change moves it,
 * or the content above it, on screen. Nothing travels: the moved thing is at
 * its new place at once and settles only the last SOFT_SETTLE_CAP_PX in the
 * direction it came from. Measured in a ResizeObserver (after layout, scroll
 * anchoring and the chat's re-pin, before paint); nothing runs at rest or
 * while scrolling. Only agent growth settles (`glideAttribution`): `grew()` or
 * a TAIL_GROWTH_EVENT under `trigger` marks it; a reader's input, or a live
 * group the reader opened, makes the change land in place.
 * - Reader scrolled up, or no scroller: `el` settles.
 * - The scroller follows the tail: the scroll stays snapped and authoritative;
 *   the content above settles and `el` is countered, so it holds still.
 * A scroller whose `data-content-glide` is "off" keeps the snap (comparison
 * only). */
export function createGlide(el: HTMLElement, trigger: Element): Glide {
  const scroller = scrollerOf(el);
  const scrollTop = () => scroller ? scroller.scrollTop : window.scrollY;
  // The chat's scroll hook publishes whether it will keep the tail in view
  // (use-sticky-bottom.ts); geometry alone cannot tell a reader who stopped
  // just above the bottom from one who follows it. No scroller: the page.
  const follows = () => scroller?.dataset.followsTail === "true";
  const content = scroller?.firstElementChild instanceof HTMLElement ? scroller.firstElementChild : null;
  const line = slider(el);
  const above = content ? slider(content, "gliding") : null;
  const measure = (): GlideMark => {
    const rect = el.getBoundingClientRect();
    // Layout position: neither glide counts.
    const top = rect.top - translateYOf(el) - (above ? above.current() : 0);
    const viewport = scroller ? scroller.getBoundingClientRect().top : 0;
    const height = scroller ? layoutScrollHeight(scroller) : document.documentElement.scrollHeight;
    return { inContainer: top - trigger.getBoundingClientRect().top, toBottom: height - (top - viewport + scrollTop()) };
  };
  let painted = scrollTop();
  let settleNext = false;
  let agentGrowth = false;
  let readerOwned = false;
  let readerInputAt = -Infinity;
  let mark = measure();
  let width = el.getBoundingClientRect().width;
  const onScroll = () => {
    painted = scrollTop();
  };
  const stop = () => {
    line.stop();
    above?.stop();
  };
  const check = () => {
    const next = measure();
    const nextWidth = el.getBoundingClientRect().width;
    const following = follows();
    const previous = mark;
    const resized = Math.abs(nextWidth - width) > 0.5;
    mark = next;
    width = nextWidth;
    const attribution = glideAttribution({ agentGrowth, sinceReaderInputMs: performance.now() - readerInputAt, resized, readerOwned });
    agentGrowth = false;
    if (settleNext || attribution === "silent" || !canAnimate(el) || prefersReducedMotion()) {
      // Not travelling: anything mid-glide is simply at its new place.
      stop();
      settleNext = false;
      return;
    }
    if (following && above && scroller?.dataset.contentGlide !== "off") {
      const { content: shift, line: counter } = followGlide(previous, next);
      // scrollHeight is whole pixels while lines are not: below 2px is rounding.
      if (Math.abs(shift) < 2 && Math.abs(shift + counter) < 2) return;
      // The content above settles its last few px; `el` (inside it) is drawn
      // where it really is, settling only if it really moved.
      const contentNow = above.current();
      const contentFrom = settleFrom(contentNow, shift);
      const lineDrawn = settleFrom(line.current() + contentNow, shift + counter);
      above.start(contentFrom);
      line.start(lineDrawn - contentFrom);
      return;
    }
    const offset = glideOffset(previous, next, following, scrollTop() - painted);
    if (Math.abs(offset) < 2) return;
    line.start(settleFrom(line.current(), offset));
  };
  const observer = new ResizeObserver(check);
  observer.observe(trigger);
  const onGrowth = () => { agentGrowth = true; };
  const onReaderInput = () => { readerInputAt = performance.now(); };
  trigger.addEventListener(TAIL_GROWTH_EVENT, onGrowth);
  const inputTarget: EventTarget = scroller ?? document;
  for (const type of READER_INPUTS) inputTarget.addEventListener(type, onReaderInput, { capture: true, passive: true });
  const target: EventTarget = scroller ?? window;
  target.addEventListener("scroll", onScroll, { passive: true });
  return {
    settle: () => {
      // Cleared two frames later, in case this change resizes nothing.
      settleNext = true;
      requestAnimationFrame(() => requestAnimationFrame(() => { settleNext = false; }));
    },
    grew: () => { agentGrowth = true; },
    readerOwns: (owned) => { readerOwned = owned; },
    dispose: () => {
      observer.disconnect();
      target.removeEventListener("scroll", onScroll);
      trigger.removeEventListener(TAIL_GROWTH_EVENT, onGrowth);
      for (const type of READER_INPUTS) inputTarget.removeEventListener(type, onReaderInput, { capture: true });
      stop();
    },
  };
}
