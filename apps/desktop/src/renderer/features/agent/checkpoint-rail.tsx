// A left-edge minimap with one tick per user message. The active tick is the
// prompt fitted to the top of the viewport (the topmost when several show).
// Hover opens the full list over the strip; a click scrolls that prompt to the
// top.
//
// A click pins its checkpoint, so the scroll-spy cannot light the next one
// after the jump; real scroll input, reaching the true bottom without a
// spacer, or a list change releases it. When the content below the prompt is
// shorter than a screen, the click grows a bottom spacer of the exact
// shortfall, which shrinks one-for-one as content streams in and is removed
// only when invisible. useStickyBottom's bottomInsetPx stops it fighting the
// spacer. Sends never route here; AgentChat reveals them itself.
//
// Ticks measure the turn container, which carries content-visibility, so its
// box is always laid out; measuring a descendant would force layout of every
// skipped turn on each frame. Off-screen turns use a 240px estimate, so a long
// jump settles and nudges onto the re-measured target; user input cancels it.

import React, {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui";
import { ActivityScope } from "../../shared/ui/loading/activity-scope";
import type { MessageNavigation } from "../../shared/lib/navigation-shortcuts";

export interface Checkpoint {
  /** The user-prompt message id — matches the `data-checkpoint-id`
   *  attribute TurnContainer stamps on the turn's wrapper div. */
  id: string;
  /** Raw prompt text; summarized to one line for the popup. */
  text: string;
}

/** A one-line preview for popup rows and tick labels: whitespace collapsed and
 *  length capped. Attachment-only prompts get an explicit label. */
export function summarizeCheckpointText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "(attachment)";
  return collapsed.length > 200 ? collapsed.slice(0, 200) : collapsed;
}

/** Same prompts in the same order, by id and preview. AgentChat rebuilds the
 *  list on every streamed chunk; returning the previous array keeps this
 *  component's memo and its per-tick measurement effect from re-running. */
export function sameCheckpoints(a: Checkpoint[], b: Checkpoint[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].text !== b[i].text) return false;
  }
  return true;
}

/** Order-sensitive signature of the ids alone, which pin and spacer upkeep key
 *  off. It catches an edit-and-resubmit that swaps the last id without
 *  changing the count. NUL cannot occur in an id. */
export function checkpointIdSignature(checkpoints: Checkpoint[]): string {
  return checkpoints.map((c) => c.id).join("\u0000");
}

/** Scroll-spy: the last checkpoint whose top has passed the anchor line, or the
 *  first above it. At the true bottom the last checkpoint wins, but only once
 *  the transcript has scrolled (scrollTop > 0): a transcript that fits is at
 *  top and bottom at once, and its first prompt is the visible one. null tops
 *  are skipped so a render race cannot throw. */
export function activeCheckpointIndex(
  tops: Array<number | null>,
  scrollTop: number,
  anchorPx: number,
  atBottom: boolean,
): number {
  if (tops.length === 0) return 0;
  let anchorIdx = 0;
  for (let i = 0; i < tops.length; i++) {
    const top = tops[i];
    if (top !== null && top - scrollTop <= anchorPx) anchorIdx = i;
  }
  if (atBottom && scrollTop > 0) return tops.length - 1;
  return anchorIdx;
}

/** Per-tick row height, tightening as checkpoints accumulate. */
export function checkpointTickPitch(count: number): number {
  if (count <= 16) return 8;
  if (count <= 32) return 6;
  return 4;
}

/** The bottom spacer that makes targetTop reachable: 0 when it already is,
 *  else the exact shortfall (ceiled), so a click lands precisely at the bottom
 *  with no leftover blank and no jump-to-latest pill. */
export function checkpointBottomSpacer(
  targetTop: number,
  contentHeight: number,
  clientHeight: number,
): number {
  const shortfall = targetTop - (contentHeight - clientHeight);
  return shortfall <= 0 ? 0 : Math.ceil(shortfall);
}

/** The spy's anchor: about a third of the viewport, clamped. Clicks land about
 *  12px below the top, well inside it, so the clicked tick lights. */
function spyAnchorPx(viewportH: number): number {
  return Math.min(Math.max(viewportH * 0.3, 48), 160);
}

/** The strip's border-box width; the popup offsets by it to open flush on top
 *  of the strip. */
const RAIL_WIDTH_PX = 28;

import { beginChatScrollNavigation, CHAT_SCROLL_NAVIGATION_EVENT, type ChatScrollNavigation } from "./chat-scroll-navigation";

interface CheckpointRailProps {
  /** False while this chat remains mounted in an off-screen retained layer. */
  active?: boolean;
  /** The transcript's scroll container (the <Conversation> element). */
  scrollEl: HTMLElement | null;
  /** User prompts in transcript order (oldest first). */
  checkpoints: Checkpoint[];
  /** The bottom spacer's current height. The rail is its only writer; the value
   *  comes back so the reach math can subtract it from scrollHeight. */
  bottomSpacerPx: number;
  onBottomSpacerChange: (px: number) => void;
  /** Lets AgentChat run a synchronous spy pass right after restoring scroll on
   *  remount, before paint; otherwise the first tick flashes for a frame.
   *  Assigned in a layout effect so it is live before the parent's restore
   *  runs. */
  recomputeRef?: React.MutableRefObject<(() => void) | null>;
  /** Keyboard jumps share the rail's user-message identity, pin and spacer. */
  navigateRef?: React.MutableRefObject<((direction: MessageNavigation) => boolean) | null>;
}

export const CheckpointRail = memo(function CheckpointRail({
  active = true,
  scrollEl,
  checkpoints,
  bottomSpacerPx,
  onBottomSpacerChange,
  recomputeRef,
  navigateRef,
}: CheckpointRailProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const local = useContext(ActivityScope) !== undefined;
  // Track dispatches rather than render state: several measurements may run
  // before React renders. No-op updaters otherwise accumulate in its queue.
  const publishedIndexRef = useRef(0);
  // The spy + click handlers read the latest list through a ref so the
  // scroll listener effect doesn't re-subscribe on every new message.
  const checkpointsRef = useRef(checkpoints);
  checkpointsRef.current = checkpoints;
  // Prop mirror for the same reason; also kept fresh through flushSync
  // (the synchronous re-render runs this assignment before the caller
  // continues).
  const bottomSpacerRef = useRef(bottomSpacerPx);
  bottomSpacerRef.current = bottomSpacerPx;

  // Explicit-click pin: while set, the spy reports THIS checkpoint as
  // active instead of deriving one from the viewport. See the header
  // comment for the release conditions.
  const pinnedIdRef = useRef<string | null>(null);
  // True from a click until its settle chain ends. On the first frame after a
  // click the viewport hasn't moved, so a fresh spacer looks out of view and the
  // position looks like the bottom; upkeep must not remove the spacer or release
  // the pin then.
  const navigatingRef = useRef(false);
  // Which checkpoint the bottom spacer was grown for — its target is
  // what the maintenance pass keeps reachable.
  const spacerForIdRef = useRef<string | null>(null);

  /** Content-relative top (scrollTop coordinate space) for every
   *  checkpoint, in list order. One querySelectorAll + N rect reads on
   *  the containment boundaries — no forced layout of skipped turns. */
  const measureTops = useCallback((): Array<number | null> => {
    if (!scrollEl) return [];
    const containerTop = scrollEl.getBoundingClientRect().top;
    const byId = new Map<string, number>();
    scrollEl
      .querySelectorAll<HTMLElement>("[data-checkpoint-id]")
      .forEach((el) => {
        const id = el.dataset.checkpointId;
        if (!id) return;
        byId.set(
          id,
          el.getBoundingClientRect().top - containerTop + scrollEl.scrollTop,
        );
      });
    return checkpointsRef.current.map((c) => byId.get(c.id) ?? null);
  }, [scrollEl]);

  /** The scrollTop a click on checkpoint id lands at, or null when its turn isn't
   *  in the DOM. -12px mirrors the transcript's pt-3. */
  const targetTopFor = useCallback(
    (id: string): number | null => {
      if (!scrollEl) return null;
      const el = scrollEl.querySelector<HTMLElement>(
        `[data-checkpoint-id="${CSS.escape(id)}"]`,
      );
      if (!el) return null;
      const containerTop = scrollEl.getBoundingClientRect().top;
      const raw =
        el.getBoundingClientRect().top - containerTop + scrollEl.scrollTop;
      return Math.max(0, Math.round(raw - 12));
    },
    [scrollEl],
  );

  const recompute = useCallback(() => {
    if (!scrollEl) return;
    if (checkpointsRef.current.length === 0) {
      // Chat truncated/cleared under an active spacer or pin — drop
      // both so they can't leak into the next transcript state.
      pinnedIdRef.current = null;
      spacerForIdRef.current = null;
      if (bottomSpacerRef.current !== 0) onBottomSpacerChange(0);
      return;
    }

    // Runs before the active-index math. While anchored, maxScroll equals the
    // target, so the spacer shrinks one-for-one as content grows and the viewport
    // stays put. It is removed only when fully below the viewport or no longer
    // needed.
    const spacer = bottomSpacerRef.current;
    if (spacer > 0) {
      const contentH = scrollEl.scrollHeight - spacer;
      const viewportBottom = scrollEl.scrollTop + scrollEl.clientHeight;
      // At or above the spacer's top edge counts as out of view, the flush case
      // included; only the first frame after a click must keep it (navigatingRef).
      // +1 for layout rounding.
      if (!navigatingRef.current && viewportBottom <= contentH + 1) {
        spacerForIdRef.current = null;
        onBottomSpacerChange(0);
      } else {
        const anchorId = spacerForIdRef.current;
        const target = anchorId === null ? null : targetTopFor(anchorId);
        if (target !== null) {
          const needed = checkpointBottomSpacer(
            target,
            contentH,
            scrollEl.clientHeight,
          );
          if (needed === 0) spacerForIdRef.current = null;
          // ±1px deadband: layout rounding must not thrash re-renders.
          if (Math.abs(needed - spacer) > 1) onBottomSpacerChange(needed);
        }
        // Anchor gone from the DOM (paged-out history) — leave the
        // spacer as-is; the out-of-view rule above collects it.
      }
    }

    // "At bottom" counts only without a spacer: with one, maxScroll is the clicked
    // checkpoint's target, so parking there means reading that checkpoint.
    const distanceFromBottom =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    const atBottom = bottomSpacerRef.current === 0 && distanceFromBottom <= 8;

    const pinnedId = pinnedIdRef.current;
    if (pinnedId !== null) {
      const idx = checkpointsRef.current.findIndex((c) => c.id === pinnedId);
      const lastIdx = checkpointsRef.current.length - 1;
      // Release at the true bottom (no spacer) when the pin isn't the last
      // checkpoint: a programmatic jump to latest, which input listeners never see.
      // Never while a click's own animation runs.
      const staleAtBottom =
        !navigatingRef.current && atBottom && idx !== lastIdx;
      if (idx !== -1 && !staleAtBottom) {
        if (!local || publishedIndexRef.current !== idx) {
          publishedIndexRef.current = idx;
          setActiveIndex((prev) => (prev === idx ? prev : idx));
        }
        return;
      }
      pinnedIdRef.current = null;
    }

    const next = activeCheckpointIndex(
      measureTops(),
      scrollEl.scrollTop,
      spyAnchorPx(scrollEl.clientHeight),
      atBottom,
    );
    if (!local || publishedIndexRef.current !== next) {
      publishedIndexRef.current = next;
      setActiveIndex((prev) => (prev === next ? prev : next));
    }
  }, [scrollEl, measureTops, targetTopFor, onBottomSpacerChange, local]);

  // Recompute on scroll (rAF-coalesced) and on any size change of the container
  // or its content column. Real scroll input (wheel, pointerdown, touchmove)
  // releases the pin; our own programmatic scrolls fire none of these.
  useEffect(() => {
    if (!active || !scrollEl) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };
    const onUserScrollInput = () => {
      pinnedIdRef.current = null;
      schedule();
    };
    const onNavigation = (event: Event) => {
      if (!(event as CustomEvent<ChatScrollNavigation>).detail?.boundary) return;
      cancelSettleRef.current();
      pinnedIdRef.current = null;
      spacerForIdRef.current = null;
      navigatingRef.current = false;
      // The boundary caller measures scrollHeight as soon as this returns.
      if (bottomSpacerRef.current > 0) flushSync(() => onBottomSpacerChange(0));
      schedule();
    };
    scrollEl.addEventListener(CHAT_SCROLL_NAVIGATION_EVENT, onNavigation);
    scrollEl.addEventListener("scroll", schedule, { passive: true });
    scrollEl.addEventListener("wheel", onUserScrollInput, { passive: true });
    scrollEl.addEventListener("touchmove", onUserScrollInput, {
      passive: true,
    });
    scrollEl.addEventListener("pointerdown", onUserScrollInput);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(schedule);
      ro.observe(scrollEl);
      const content = scrollEl.firstElementChild;
      if (content) ro.observe(content);
    }
    recompute();
    return () => {
      scrollEl.removeEventListener(CHAT_SCROLL_NAVIGATION_EVENT, onNavigation);
      scrollEl.removeEventListener("scroll", schedule);
      scrollEl.removeEventListener("wheel", onUserScrollInput);
      scrollEl.removeEventListener("touchmove", onUserScrollInput);
      scrollEl.removeEventListener("pointerdown", onUserScrollInput);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, scrollEl, recompute, onBottomSpacerChange]);

  // The list changed (prompt sent, history paged in, truncation, or an edit that
  // swaps the last id): unpin, drop the spacer and re-evaluate, since a short
  // chat never fires a scroll event. Keyed on the id signature, not the count,
  // or an edit-and-resubmit strands an oversized spacer bound to a removed id.
  const prevIdSigRef = useRef<string | null>(null);
  useEffect(() => {
    const idSig = checkpointIdSignature(checkpoints);
    if (prevIdSigRef.current !== null && idSig !== prevIdSigRef.current) {
      pinnedIdRef.current = null;
      spacerForIdRef.current = null;
      if (bottomSpacerRef.current !== 0) onBottomSpacerChange(0);
    }
    prevIdSigRef.current = idSig;
    if (active) recompute();
  }, [active, checkpoints, recompute, onBottomSpacerChange]);

  // Cancel any pending settle pass when the retained view goes off-screen or
  // unmounts, so delayed correction frames cannot move a parked transcript.
  const cancelSettleRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (active) return;
    cancelSettleRef.current();
    // Reasserting the current position with auto behavior also cancels the
    // browser's native smooth-scroll animation, not only our settle timers.
    scrollEl?.scrollTo({ top: scrollEl.scrollTop, behavior: "auto" });
  }, [active, scrollEl]);
  useEffect(() => () => cancelSettleRef.current(), []);

  const scrollToCheckpoint = useCallback(
    (id: string) => {
      if (!scrollEl) return;
      cancelSettleRef.current();

      // Grow the spacer when target is past maxScroll. flushSync: it must be in the
      // DOM before scrollTo or the browser clamps. Growth only; shrinking here could
      // shift the viewport before the jump.
      const ensureReachable = (target: number) => {
        const needed = checkpointBottomSpacer(
          target,
          scrollEl.scrollHeight - bottomSpacerRef.current,
          scrollEl.clientHeight,
        );
        if (needed > bottomSpacerRef.current) {
          spacerForIdRef.current = id;
          flushSync(() => onBottomSpacerChange(needed));
        }
      };

      const target = targetTopFor(id);
      if (target === null) return;
      beginChatScrollNavigation(scrollEl, { target });

      // Pin before the jump: the clicked checkpoint stays selected even
      // when another checkpoint also fits in the destination viewport.
      pinnedIdRef.current = id;
      navigatingRef.current = true;
      const idx = checkpointsRef.current.findIndex((c) => c.id === id);
      if (idx !== -1 && (!local || publishedIndexRef.current !== idx)) {
        publishedIndexRef.current = idx;
        setActiveIndex(idx);
      }

      ensureReachable(target);
      // Navigator selection is a direct jump at any distance. Intermediate
      // history must not pass through the viewport on the way to the target.
      scrollEl.scrollTo({ top: target, behavior: "auto" });

      // Re-measure once layout replaces estimates and correct without animation;
      // two passes converge, and user input cancels the chain.
      let passes = 0;
      const arm = () => {
        let finished = false;
        const cleanup = () => {
          scrollEl.removeEventListener(CHAT_SCROLL_NAVIGATION_EVENT, onUserInput);
          scrollEl.removeEventListener("scrollend", onEnd);
          scrollEl.removeEventListener("wheel", onUserInput);
          scrollEl.removeEventListener("pointerdown", onUserInput);
          window.clearTimeout(timer);
        };
        const finish = () => {
          if (finished) return;
          finished = true;
          cleanup();
          const t = targetTopFor(id);
          if (t === null || Math.abs(scrollEl.scrollTop - t) <= 6) {
            navigatingRef.current = false;
            // A final spy pass lets the suspended upkeep rules see the resting position.
            recompute();
            return;
          }
          passes += 1;
          // Real layout may have shrunk the estimates the spacer was
          // computed from — re-assert reachability before the nudge.
          ensureReachable(t);
          scrollEl.scrollTo({
            top: t,
            behavior: "auto",
          });
          if (passes < 2) arm();
          else {
            navigatingRef.current = false;
            recompute();
          }
        };
        const onEnd = () => finish();
        const onUserInput = () => {
          finished = true;
          navigatingRef.current = false;
          cleanup();
        };
        scrollEl.addEventListener(CHAT_SCROLL_NAVIGATION_EVENT, onUserInput, { once: true });
        scrollEl.addEventListener("scrollend", onEnd, { once: true });
        scrollEl.addEventListener("wheel", onUserInput, {
          once: true,
          passive: true,
        });
        scrollEl.addEventListener("pointerdown", onUserInput, { once: true });
        // Bound the settle pass in environments without scrollend.
        const timer = window.setTimeout(finish, 700);
        cancelSettleRef.current = onUserInput;
      };
      arm();
    },
    [scrollEl, targetTopFor, onBottomSpacerChange, recompute, local],
  );

  // A layout effect: React fires them child-first, so this is assigned before
  // AgentChat's restore layout effect calls it.
  useLayoutEffect(() => {
    if (!recomputeRef) return;
    recomputeRef.current = active ? recompute : null;
    return () => {
      recomputeRef.current = null;
    };
  }, [active, recomputeRef, recompute]);

  useLayoutEffect(() => {
    if (!navigateRef) return;
    navigateRef.current = active && scrollEl ? direction => {
      const rows = checkpointsRef.current;
      if (rows.length === 0) return false;
      // Scroll input and repeated keypresses can precede React's next render.
      // The spy's published index includes the current explicit rail pin.
      recompute();
      const index = direction === "first" ? 0 : direction === "last" ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, publishedIndexRef.current + (direction === "previous" ? -1 : 1)));
      scrollToCheckpoint(rows[index].id);
      return true;
    } : null;
    return () => { navigateRef.current = null; };
  }, [active, navigateRef, recompute, scrollEl, scrollToCheckpoint]);

  // Keep the active row visible in the popup; block:"nearest" scrolls only the
  // popup's own viewport.
  const scrollActiveRowIntoView = useCallback(
    (el: HTMLButtonElement | null) => {
      el?.scrollIntoView({ block: "nearest" });
    },
    [],
  );

  // One checkpoint has nothing to navigate between, so the strip hides until a
  // second prompt; the hooks above still collect any leftover spacer.
  if (!scrollEl || checkpoints.length < 2) return null;

  const pitch = checkpointTickPitch(checkpoints.length);

  return (
    <HoverCard openDelay={150} closeDelay={150}>
      <HoverCardTrigger asChild>
        {/* The hit zone is the tick stack only, so the transcript beside it stays
            selectable. z-[8] sits above the top mask and below the jump pill. */}
        <nav
          aria-label="Chat checkpoints"
          className="group/rail absolute top-3 left-1 z-[8] flex max-h-[calc(100%-4rem)] flex-col overflow-hidden p-1"
        >
          {checkpoints.map((c, i) => (
            <button
              key={c.id}
              type="button"
              onClick={() => scrollToCheckpoint(c.id)}
              aria-label={`Jump to: ${summarizeCheckpointText(c.text)}`}
              aria-current={i === activeIndex ? "true" : undefined}
              className="flex w-5 cursor-pointer items-center focus-visible:outline-none"
              style={{ height: pitch }}
            >
              {/* Active state is color only; every tick has the same width. */}
              <span
                className={cn(
                  "h-0.5 w-3 rounded-full transition-colors duration-200 ease-out",
                  i === activeIndex
                    ? "bg-fg1"
                    : "bg-muted-fg/45 group-hover/rail:bg-muted-fg/70",
                )}
              />
            </button>
          ))}
        </nav>
      </HoverCardTrigger>
      {/* Opens on top of the strip: sideOffset={-RAIL_WIDTH_PX} makes the left
          edges flush, so each row carries its own tick and reads as the expanded
          strip. */}
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={-RAIL_WIDTH_PX}
        alignOffset={0}
        collisionPadding={12}
        className="flex max-h-[min(28rem,70vh)] w-72 flex-col gap-1 overflow-y-auto p-1.5"
      >
        {checkpoints.map((c, i) => (
          <button
            key={c.id}
            type="button"
            ref={i === activeIndex ? scrollActiveRowIntoView : undefined}
            onClick={() => scrollToCheckpoint(c.id)}
            // Only the selected row's text is fg1; hover changes the background only.
            className={cn(
              "flex h-8 w-full flex-none cursor-pointer items-center gap-2.5 rounded-md px-2 text-left transition-colors",
              // The selected row keeps bg2-hover, the hover fill of its siblings.
              // --highlighted-bg is the user-bubble surface and would sit darker.
              i === activeIndex
                ? "bg-bg2-hover text-fg1"
                : "text-fg2 hover:bg-bg2-hover",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "h-0.5 w-3 flex-none rounded-full transition-colors duration-200 ease-out",
                i === activeIndex ? "bg-fg1" : "bg-muted-fg/45",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-xs leading-snug">
              {summarizeCheckpointText(c.text)}
            </span>
          </button>
        ))}
      </HoverCardContent>
    </HoverCard>
  );
});
