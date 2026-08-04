// ──────────────────────────────────────────────────────────
// CheckpointRail — left-edge user-message minimap for the chat
// ──────────────────────────────────────────────────────────
//
// The Claude Code-style checkpoint strip (2026-07-15 user spec): a
// vertical stack of small tick marks overlaid on the left edge of the
// transcript, one tick per user message. The bright tick (same width
// as the rest — color is the only active cue, 2026-07-16 spec) tracks
// which checkpoint region the viewport is currently in — "one user
// message to the next user message is the checkpoint." The active tick
// is the user message fitted to the TOP of the viewport: when several
// prompts are on screen the topmost takes precedence, so a short chat
// whose first prompt sits at the top keeps its FIRST tick lit (the
// 2026-07-16 fix — a fitting 2-message chat used to flicker onto the
// 2nd tick on tab switch because "at the bottom" forced the last tick
// even when the transcript hadn't scrolled at all). Hovering the
// strip opens a popup listing every user message (tick + single-line
// preview per row) ON TOP of the strip, top-aligned with it
// (2026-07-16 user spec); clicking a tick or a popup row scrolls that
// user message to the top of the viewport.
//
// Click semantics (2026-07-16 follow-ups):
//   1. An explicit click PINS the clicked checkpoint as the active
//      one. Without the pin, the scroll-spy re-derived the active
//      region after the jump and could highlight the NEXT checkpoint
//      (both fit in the viewport, or the bottom rule fired) — "I
//      clicked the 3rd but the 4th lit up." The pin releases on real
//      user scroll input (wheel / pointer / touch on the scroller),
//      when the user is back at the true bottom without a spacer
//      (jump-to-latest), or when the checkpoint list changes.
//   2. Clicking a checkpoint whose remaining content is shorter than
//      a screen (typically the LAST one) grows a bottom spacer inside
//      the scroll content (rendered by AgentChat, sized only here) so
//      the prompt can still land at the top. The spacer is the EXACT
//      shortfall — maxScroll == target — so the click lands precisely
//      at the bottom: no leftover scrollable blank and no
//      jump-to-latest pill over a fully visible transcript (2026-07-16
//      user report). When the content below the prompt is a screen or
//      taller, no spacer is created at all. The auto-follow fight this
//      would otherwise cause is handled by useStickyBottom's
//      bottomInsetPx option (agent-chat passes the spacer height):
//      while active, the hook suspends its snap and treats the CONTENT
//      bottom as "bottom". Maintenance in the spy loop keeps maxScroll
//      == target as content streams in (the spacer shrinks 1:1 with
//      growth, so the pinned prompt never moves), and removes the
//      spacer only when that removal is invisible: once it sits at or
//      below the viewport's bottom edge, or it shrinks to zero on its
//      own.
//   3. SENDING a prompt does NOT route through this flow (2026-07-17
//      user spec, retiring the 2026-07-16 send-follow): top-framing is
//      exclusively the rail's click behavior. AgentChat handles sends
//      itself — a sent prompt that renders out of view is revealed
//      with a plain scroll to the bottom (see its send-jump effect).
//
// Measurement strategy — why ticks key off the TURN CONTAINER:
// finalized turns render with `content-visibility: auto`, so calling
// getBoundingClientRect on a DESCENDANT (e.g. the prompt bubble)
// would force the browser to lay out every skipped turn on every
// scroll frame. The turn container itself is the element carrying the
// containment, so its own box is always laid out (real or
// contain-intrinsic-size estimate) and measuring it is free. The
// container's top == the prompt header's top (the prompt is the
// turn's first child), so the tick math is unaffected. TurnContainer
// stamps `data-checkpoint-id` with the user-prompt message id.
//
// Because off-screen turns are sized by a 240px estimate, a long jump
// can land slightly off once real layout replaces the estimates. The
// click handler runs settle passes after the smooth scroll finishes
// (scrollend, with a timeout fallback) and nudges the viewport onto
// the re-measured target; a user wheel/pointer input cancels the
// pending pass so we never fight the user for the scroll position.
// ──────────────────────────────────────────────────────────

import React, {
  memo,
  useCallback,
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
} from "../ui/primitives";
import { cn } from "../ui";

export interface Checkpoint {
  /** The user-prompt message id — matches the `data-checkpoint-id`
   *  attribute TurnContainer stamps on the turn's wrapper div. */
  id: string;
  /** Raw prompt text; summarized to one line for the popup. */
  text: string;
}

/** One-line preview for the popup rows + tick aria-labels. Collapses
 *  internal whitespace (multi-paragraph prompts read as one line; CSS
 *  truncation supplies the ellipsis) and caps the length so a pasted
 *  wall of text doesn't ride into the DOM. Attachment-only prompts
 *  have empty text — label those explicitly instead of rendering a
 *  blank row. */
export function summarizeCheckpointText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "(attachment)";
  return collapsed.length > 200 ? collapsed.slice(0, 200) : collapsed;
}

/** Referential-stability equality for the checkpoint list: equivalent
 *  when the two lists hold the same prompts in the same order — same id
 *  AND same preview text. AgentChat rebuilds this list on every streamed
 *  chunk (turn grouping hands back a fresh array as assistant content
 *  appends) even though the user prompts are unchanged; comparing here
 *  lets AgentChat return the PREVIOUS array reference so CheckpointRail's
 *  memo holds and its `[checkpoints]` effect doesn't re-measure every
 *  tick per chunk. Text is part of the identity so an edited preview
 *  still propagates to the popup rows. */
export function sameCheckpoints(a: Checkpoint[], b: Checkpoint[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].text !== b[i].text) return false;
  }
  return true;
}

/** Order-sensitive signature of the checkpoint IDS (text excluded). The
 *  pin + bottom-spacer maintenance keys off ids alone, so this is what
 *  the rail compares to decide the list's COMPOSITION changed — a prompt
 *  appended, history paged in, the transcript truncated, or (the case a
 *  bare count check misses) the latest prompt edited-and-resubmitted,
 *  which swaps the last id without changing the length. A NUL (\u0000)
 *  separator can't occur inside a message id, so the join is
 *  unambiguous. */
export function checkpointIdSignature(checkpoints: Checkpoint[]): string {
  return checkpoints.map((c) => c.id).join("\u0000");
}

/** Scroll-spy: which checkpoint region is the viewport in? The active
 *  checkpoint is the LAST one whose top edge has passed the anchor line
 *  (viewport top + anchorPx) — i.e. the user message currently fitted to
 *  the top of the viewport wins (2026-07-16 user spec: when several
 *  prompts are on screen, the TOPMOST takes precedence). Above the first
 *  prompt → first.
 *
 *  "At the bottom → last" is a REFINEMENT of that rule, not an override:
 *  a reader parked at the true bottom is in the latest exchange, so the
 *  last checkpoint wins even when its short answer leaves its prompt
 *  below the anchor line — BUT only once the transcript has actually
 *  scrolled (`scrollTop > 0`). When the whole transcript fits, scrollTop is
 *  pinned at 0 and the viewport is at the top AND the bottom at once; the
 *  first prompt is visibly at the top, so forcing "last" there lights the
 *  wrong tick. Using scrollTop rather than anchorIdx matters for a scrollable
 *  two-prompt transcript parked at the bottom: its second prompt can still
 *  sit below the anchor even though the reader has left the top. `null` tops
 *  (checkpoint not in the DOM — shouldn't happen, but the rail must never
 *  throw over a render race) are skipped. */
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

/** Per-tick row height (2px bar + hit padding). Tightens as the chat
 *  accumulates checkpoints so the strip stays compact; the popup list
 *  is the full-fidelity view, the strip is the at-a-glance one. */
export function checkpointTickPitch(count: number): number {
  if (count <= 16) return 8;
  if (count <= 32) return 6;
  return 4;
}

/** Bottom spacer height needed so `targetTop` is a reachable
 *  scrollTop. `contentHeight` is the scroller's scrollHeight
 *  EXCLUDING any spacer already present. Returns 0 when the target is
 *  reachable without help (no gratuitous blank space at the bottom of
 *  every chat); otherwise the EXACT shortfall (ceil'd so the target
 *  is never a fraction of a px past maxScroll), making maxScroll ==
 *  targetTop — landing a click puts the viewport precisely AT the
 *  bottom, so there is no leftover scrollable blank and the
 *  jump-to-latest pill stays hidden (2026-07-16 user report; an
 *  earlier revision padded this with 48px of slack to keep
 *  useStickyBottom from re-engaging — that job moved into the hook's
 *  bottomInsetPx option, which suspends the snap and measures
 *  "at bottom" against the content bottom while a spacer is active). */
export function checkpointBottomSpacer(
  targetTop: number,
  contentHeight: number,
  clientHeight: number,
): number {
  const shortfall = targetTop - (contentHeight - clientHeight);
  return shortfall <= 0 ? 0 : Math.ceil(shortfall);
}

/** Anchor offset for the spy: ~1/3 of the viewport, clamped so tiny
 *  panes don't anchor at the very top edge and tall monitors don't
 *  flip the active tick half a screen early. Clicking a checkpoint
 *  scrolls its prompt to ~12px below the top, well inside this band,
 *  so navigation always lands on the tick you clicked. */
function spyAnchorPx(viewportH: number): number {
  return Math.min(Math.max(viewportH * 0.3, 48), 160);
}

/** Width of the tick strip's border box: w-5 buttons + p-1 padding.
 *  The popup's negative sideOffset is derived from this so it opens
 *  exactly ON TOP of the strip (left edges flush). */
const RAIL_WIDTH_PX = 28;

interface CheckpointRailProps {
  /** False while this chat remains mounted in an off-screen retained layer. */
  active?: boolean;
  /** The transcript's scroll container (the <Conversation> element). */
  scrollEl: HTMLElement | null;
  /** User prompts in transcript order (oldest first). */
  checkpoints: Checkpoint[];
  /** Current height of the bottom spacer AgentChat renders at the tail
   *  of the scroll content. The rail is the sole writer (via
   *  onBottomSpacerChange); the value is passed back in so the reach
   *  math can subtract it from scrollHeight. */
  bottomSpacerPx: number;
  onBottomSpacerChange: (px: number) => void;
  /** Imperative handle (2026-07-16 mount-flicker fix): lets AgentChat
   *  force a synchronous scroll-spy pass right after it restores the
   *  per-chat scroll position on remount. The rail seeds activeIndex to 0
   *  and its own recompute runs in a POST-paint effect, so a chat
   *  restored below the top would paint the 1st tick for one frame, then
   *  snap to the real region — a visible flash on a cold/remounted return to a
   *  scrolled chat. AgentChat calls this from the same layout effect that
   *  sets scrollTop (before paint), so the correct tick is already lit on
   *  the first frame. A ref (assigned in a LAYOUT effect so it's live
   *  before the parent's restore layout effect runs) rather than a prop so
   *  the memo isn't churned. */
  recomputeRef?: React.MutableRefObject<(() => void) | null>;
}

export const CheckpointRail = memo(function CheckpointRail({
  active = true,
  scrollEl,
  checkpoints,
  bottomSpacerPx,
  onBottomSpacerChange,
  recomputeRef,
}: CheckpointRailProps) {
  const [activeIndex, setActiveIndex] = useState(0);
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
  // True from a checkpoint click until its settle chain finishes (or a
  // user input cancels it). The maintenance pass must not run its
  // DESTRUCTIVE rules mid-flight: on the first frame after a click the
  // viewport hasn't moved yet, so a just-grown spacer still reads as
  // "fully out of view" (viewport bottom == old content bottom) and
  // the position still reads as "at the true bottom" — removing the
  // spacer / releasing the pin right there kills the navigation the
  // click just started.
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

  /** The scrollTop a click on checkpoint `id` should land at, or null
   *  if the turn isn't in the DOM. -12px mirrors the transcript's
   *  pt-3: the clicked bubble rests at the same gap below the tab
   *  strip as the first message at rest, i.e. "fits into the user
   *  message at the top." */
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

    // ── Spacer maintenance ─────────────────────────────────────
    // Runs before the active-index math so the spy sees a spacer that
    // is (about to be) consistent. Invariant while anchored: maxScroll
    // == anchorTarget, so as streamed content grows below the
    // anchor the spacer shrinks 1:1 and the viewport (parked at
    // maxScroll) never moves. Removal happens only when invisible:
    // the spacer sits fully below the viewport, or `needed` reached 0
    // (content now fills the screen past the target on its own).
    const spacer = bottomSpacerRef.current;
    if (spacer > 0) {
      const contentH = scrollEl.scrollHeight - spacer;
      const viewportBottom = scrollEl.scrollTop + scrollEl.clientHeight;
      // "At or above the spacer's top edge" counts as out of view —
      // removal can't shift anything the user sees. The == case (a
      // jump-to-latest landing the content bottom exactly flush) must
      // collect the spacer too; the one same-geometry moment that must
      // NOT collect it is the first frame after a click grows it
      // (viewport hasn't moved yet) — that's what navigatingRef
      // covers. +1: layout rounding.
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

    // "At bottom" only counts with NO spacer: the spacer makes
    // maxScroll == the clicked checkpoint's target (exact, no slack),
    // so a viewport parked at maxScroll means "reading the clicked
    // checkpoint," not "in the latest exchange" — forcing the last
    // tick there would resurrect the clicked-3rd-lights-up-4th bug the
    // moment the pin releases.
    const distanceFromBottom =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    const atBottom = bottomSpacerRef.current === 0 && distanceFromBottom <= 8;

    // ── Pin resolution ─────────────────────────────────────────
    const pinnedId = pinnedIdRef.current;
    if (pinnedId !== null) {
      const idx = checkpointsRef.current.findIndex((c) => c.id === pinnedId);
      const lastIdx = checkpointsRef.current.length - 1;
      // Release when the user is at the true bottom (no spacer — see
      // atBottom above) and the pin isn't the last checkpoint — that's
      // a jump-to-latest (programmatic, so the input listeners never
      // saw it); parked at the bottom unambiguously means "in the
      // latest exchange." Never while a click's own animation is in
      // flight: its first frames still measure at the pre-click
      // position.
      const staleAtBottom =
        !navigatingRef.current && atBottom && idx !== lastIdx;
      if (idx !== -1 && !staleAtBottom) {
        setActiveIndex((prev) => (prev === idx ? prev : idx));
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
    // Identity-guarded set — scroll frames where the region didn't
    // change must not re-render the rail.
    setActiveIndex((prev) => (prev === next ? prev : next));
  }, [scrollEl, measureTops, targetTopFor, onBottomSpacerChange]);

  // Track scroll (rAF-coalesced) + any size change: streaming growth,
  // tool-card expand/collapse, and column resizes all move checkpoint
  // offsets without a scroll event. Same observe-container-and-content
  // pattern as useStickyBottom (the container's box is pinned by flex,
  // so content growth only fires on the firstElementChild observer —
  // which also covers the bottom spacer, an element of that column).
  // The same effect owns the pin-release listeners: real user scroll
  // INPUT (wheel / pointerdown / touchmove on the scroller) hands
  // active-tick tracking back to the spy. Programmatic scrolls (our
  // own settle passes, sticky-bottom) fire none of these, so they
  // can't accidentally unpin.
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
      scrollEl.removeEventListener("scroll", schedule);
      scrollEl.removeEventListener("wheel", onUserScrollInput);
      scrollEl.removeEventListener("touchmove", onUserScrollInput);
      scrollEl.removeEventListener("pointerdown", onUserScrollInput);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, scrollEl, recompute]);

  // The checkpoint list changed under the spy — new prompt sent, older
  // history paged in, transcript truncated, or the latest prompt
  // edited-and-resubmitted (same COUNT, new id). Unpin + drop the spacer
  // (a fresh prompt means sticky-bottom takes over and the blank tail
  // must not be part of "bottom"; on a history prepend the user is far
  // above, so the removal is invisible), then re-evaluate even if no
  // scroll event fires (short chats that don't scroll never emit one).
  //
  // Keyed on an id SIGNATURE, not the count: edit-and-resubmit truncates
  // the latest prompt and re-appends it with a fresh id, so the id
  // changes while the length holds. A bare count check skipped this
  // branch, leaving spacerForIdRef bound to the REMOVED id — stranding
  // an oversized spacer that maintenance can't shrink (its anchor id is
  // gone from the DOM), leaving blank tail space and sticky-follow
  // suspended. Dropping it here keeps the spacer honest; a later tick
  // click rebuilds an exact one for whatever id it targets.
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

      // Grow the bottom spacer if `target` is beyond maxScroll (the
      // "last message with a short answer" case). flushSync: the
      // spacer div must be IN THE DOM before scrollTo, or the browser
      // clamps the scroll short. Growth only — an oversized leftover
      // spacer from an earlier click shrinks via the maintenance pass
      // instead, because shrinking here could clamp scrollTop and
      // visibly jump the viewport before the animation starts.
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

      // Pin BEFORE the animation: the clicked checkpoint is the
      // selected one from this instant, whatever the spy would derive
      // from the frames flying past (2026-07-16 fix: clicking the 3rd
      // used to light up the 4th once both fit in the viewport).
      pinnedIdRef.current = id;
      navigatingRef.current = true;
      const idx = checkpointsRef.current.findIndex((c) => c.id === id);
      if (idx !== -1) setActiveIndex(idx);

      ensureReachable(target);
      // Long-jump hop (2026-07-17 user spec): a target many screens
      // away must NOT smooth-scroll through the whole transcript — the
      // ride is long and the flying frames are meaningless. Instead the
      // viewport teleports (instant; a programmatic scrollTop set fires
      // no wheel/pointer input, so the pin holds and nothing flashes)
      // to exactly one screen short of the target on the approach side,
      // and the smooth scroll animates only that final screen. The user
      // perceives the same glide-and-settle motion at ANY distance,
      // with a constant, snappy duration.
      const distance = target - scrollEl.scrollTop;
      const hop = scrollEl.clientHeight;
      if (Math.abs(distance) > hop * 2.5) {
        scrollEl.scrollTop = distance > 0 ? target - hop : target + hop;
      }
      scrollEl.scrollTo({ top: target, behavior: "smooth" });

      // Settle passes — re-measure once the smooth scroll finishes and
      // nudge onto the true offset (estimates above the target may have
      // been replaced by real layout mid-flight). Two passes converge in
      // practice; a wheel/pointer input from the user cancels the chain.
      let passes = 0;
      const arm = () => {
        let finished = false;
        const cleanup = () => {
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
            // One post-flight spy pass: the maintenance rules this
            // navigation suspended (stale-spacer collection above all)
            // must get a look at the final resting position — nothing
            // else re-triggers recompute when the animation ends
            // exactly on target.
            recompute();
            return;
          }
          passes += 1;
          // Real layout may have shrunk the estimates the spacer was
          // computed from — re-assert reachability before the nudge.
          ensureReachable(t);
          scrollEl.scrollTo({
            top: t,
            // First correction stays smooth (it can be a visible hop);
            // the last one snaps the residual few px invisibly.
            behavior: passes >= 2 ? "auto" : "smooth",
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
        scrollEl.addEventListener("scrollend", onEnd, { once: true });
        scrollEl.addEventListener("wheel", onUserInput, {
          once: true,
          passive: true,
        });
        scrollEl.addEventListener("pointerdown", onUserInput, { once: true });
        // Fallback for environments without scrollend; generous enough
        // for the longest smooth animation.
        const timer = window.setTimeout(finish, 700);
        cancelSettleRef.current = onUserInput;
      };
      arm();
    },
    [scrollEl, targetTopFor, onBottomSpacerChange, recompute],
  );

  // Publish the scroll-spy pass for AgentChat's mount-time restore (see
  // the prop doc). A LAYOUT effect, not a passive one: on remount it must
  // be assigned before AgentChat's own restore layout effect runs — React
  // fires layout effects child-first, so the rail (a descendant) lands
  // its assignment ahead of the parent's restore, which then calls it
  // right after setting scrollTop, seeding the correct active tick before
  // the first paint.
  useLayoutEffect(() => {
    if (!recomputeRef) return;
    recomputeRef.current = active ? recompute : null;
    return () => {
      recomputeRef.current = null;
    };
  }, [active, recomputeRef, recompute]);

  // Keep the active row visible inside the (scrollable) popup — fires
  // when the popup mounts and again whenever the active row moves.
  // block:"nearest" scopes the scroll to the popup viewport (its only
  // scrollable ancestor — the content portals to <body>).
  const scrollActiveRowIntoView = useCallback(
    (el: HTMLButtonElement | null) => {
      el?.scrollIntoView({ block: "nearest" });
    },
    [],
  );

  // A one-checkpoint chat has nothing to navigate BETWEEN, so a lone
  // tick is pointless chrome (2026-07-17 user spec: don't show the rail
  // for a single user message — render the strip only once a second
  // prompt gives the reader somewhere to jump). The spy/maintenance
  // hooks above still run at one checkpoint, so any leftover spacer is
  // still collected while the strip is hidden.
  if (!scrollEl || checkpoints.length < 2) return null;

  const pitch = checkpointTickPitch(checkpoints.length);

  return (
    <HoverCard openDelay={150} closeDelay={150}>
      <HoverCardTrigger asChild>
        {/* The hover/hit zone is exactly the tick stack (plus 4px of
            padding), NOT a full-height strip — the left edge below the
            ticks stays clickable/selectable transcript. top-3 aligns
            with the content's pt-3; z-[8] paints above the top fade
            mask (z-[6]) and below the jump pill (z-10). max-h +
            overflow-hidden is a backstop for pathological chats
            (>~100 prompts); the popup list remains complete. */}
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
              {/* Active state is COLOR-ONLY (2026-07-16 user spec): all
                  ticks share the same 12px width; the bright one is the
                  current checkpoint. */}
              <span
                className={cn(
                  "h-0.5 w-3 rounded-full transition-colors duration-200 ease-out",
                  i === activeIndex
                    ? "bg-fg1"
                    : "bg-fg3/45 group-hover/rail:bg-fg3/70",
                )}
              />
            </button>
          ))}
        </nav>
      </HoverCardTrigger>
      {/* Popup placement (2026-07-16 user spec): ON TOP of the tick
          strip, top-aligned — not beside it. side="right" +
          sideOffset={-RAIL_WIDTH_PX} pulls the panel back by exactly
          the trigger's width so their left edges are flush;
          align="start" + alignOffset={0} matches their top edges. The
          panel covering the strip is also why each row carries its own
          tick mark (below): the popup reads as the expanded strip, à la
          Claude Code. Hover continuity is free — the pointer leaves the
          trigger straight onto the content, which HoverCard treats as
          still-open. */}
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={-RAIL_WIDTH_PX}
        alignOffset={0}
        collisionPadding={12}
        // gap-1 (4px) between rows + fixed h-8 (32px) rows — 2026-07-16
        // user spec for the list's rhythm.
        className="flex max-h-[min(28rem,70vh)] w-72 flex-col gap-1 overflow-y-auto p-1.5"
      >
        {checkpoints.map((c, i) => (
          <button
            key={c.id}
            type="button"
            ref={i === activeIndex ? scrollActiveRowIntoView : undefined}
            onClick={() => scrollToCheckpoint(c.id)}
            // Only the SELECTED row's text reads as fg1; hover changes
            // the background only, never the text color (2026-07-16
            // user spec). flex-none: h-8 must not compress when the
            // list overflows its max-h.
            className={cn(
              "flex h-8 w-full flex-none cursor-pointer items-center gap-2.5 rounded-md px-2 text-left transition-colors",
              // Selected row is pinned to bg2-hover — the same fill its
              // siblings get on hover ("selected = the hover that doesn't go
              // away"). It used --highlighted-bg, which rendered within 1/255
              // of bg2-hover, but that token is the user-bubble surface and
              // dropped to 12% L on 2026-08-02: the selected row would have
              // sat DARKER than any hovered row.
              i === activeIndex
                ? "bg-bg2-hover text-fg1"
                : "text-fg2 hover:bg-bg2-hover",
            )}
          >
            {/* Row tick — mirrors the strip's marks (same width, bright
                color for the active row) so the popup visually extends
                the lines it covers. */}
            <span
              aria-hidden="true"
              className={cn(
                "h-0.5 w-3 flex-none rounded-full transition-colors duration-200 ease-out",
                i === activeIndex ? "bg-fg1" : "bg-fg3/45",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-[13px] leading-snug">
              {summarizeCheckpointText(c.text)}
            </span>
          </button>
        ))}
      </HoverCardContent>
    </HoverCard>
  );
});
