// ============================================
// COMPONENT: ActivityShimmer
// PURPOSE: Show the agent at work (the glass square) with its working timer
//          or the subject the caller names (the current tool call), and,
//          when opted in, its gibberish thinking phrase.
// USED IN: The active agent turn's trailing activity row.
// ============================================

// --- IMPORTS ---
import { memo, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/renderer/shared/ui/cn";

import { GIBBERISH_THINKING_MS, gibberishThinking } from "./gibberish-thinking";
import { WorkingDuration } from "./live-duration";
import { startLoaderRun } from "./loader-loop";
import { ZerosSpinner } from "./zeros-spinner";
import { ActivityScope } from "./activity-scope";
import { startElapsedDisplay } from "./elapsed-display";
import { loaderTickDelay } from "./loader-ticker";
import { SOFT_ENTER_DELAY_MS, SOFT_ENTER_TRAVEL_PX, softEnter, softExit } from "../motion/soft-motion";

// --- TYPES ---
export interface ActivityShimmerProps {
  /** Start time used by the ticking elapsed counter. */
  startedAt: number;
  /** Optional layout classes supplied by the activity-row owner. */
  className?: string;
  /** Show gibberish thinking phrases ("Thenkeng"), a new one every three
   *  seconds, between the loader and the timer: Settings → Experimental →
   *  Gibberish agent thinking. Off by default. */
  gibberish?: boolean;
  /** Replaces the timer. A new `key` slides in over the previous subject. */
  subject?: { key: string; label: ReactNode } | null;
  /** The loader alone: what it would name is already visible. */
  bare?: boolean;
  /** A new value swaps the subject without a dissolve: its label has moved
   * into the feed as a row at the same place. */
  resetKey?: string;
  /** The subject's call just became a new group's header at its own row. */
  tucked?: boolean;
}

const TICKER_ITEM = "col-start-1 row-start-1 flex min-w-0 items-center gap-2";
/** The idle subject: the run closed, so the line returns to it at once. */
const TIMER_KEY = "timer";

type TickerItem = { key: string; node: ReactNode };

/** One line that hands a new subject over the previous one as a soft
 * dissolve (shared/ui/motion/soft-motion.ts): the old one drifts up and out
 * while the new one rises in, overlapping. The first subject appears without
 * motion. Each subject stays at least LOADER_TICK_DWELL_MS; a newer one
 * waits, and ones that came and went meanwhile are skipped. A new `resetKey`
 * swaps silently: the caller has moved the old subject into the feed. Items
 * keep their DOM node from entering to leaving, so an interrupted dissolve
 * continues from where it is. */
function LoaderTicker({ itemKey, resetKey, tucked = false, children }: { itemKey: string; resetKey?: string; tucked?: boolean; children: ReactNode }) {
  const painted = useRef<TickerItem>({ key: itemKey, node: children });
  const reset = useRef(resetKey);
  const [shown, setShown] = useState<{ key: string; at: number; moved: boolean; leaving: TickerItem | null; swap: number }>(
    () => ({ key: itemKey, at: performance.now(), moved: false, leaving: null, swap: 0 }),
  );
  const [, wake] = useState(0);
  const silent = reset.current !== resetKey;
  const delay = silent ? 0 : loaderTickDelay(shown, itemKey, performance.now(), itemKey === TIMER_KEY);
  if (shown.key !== itemKey && delay === 0) {
    // The previous subject leaves as it was last painted.
    // Tucked: the old call became the group header at its own row, so it does
    // not leave from the line; only the new call appears (one row lower).
    setShown({ key: itemKey, at: performance.now(), moved: !silent, swap: shown.swap + 1,
      leaving: !silent && !tucked && painted.current.key === shown.key ? painted.current : null });
  }
  const current = shown.key === itemKey;
  const nodes = useRef(new Map<string, HTMLSpanElement>());
  const cell = useRef<HTMLSpanElement>(null);
  const lineTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    reset.current = resetKey;
    if (current) painted.current = { key: itemKey, node: children };
  });
  useLayoutEffect(() => {
    if (!shown.moved) return;
    const leavingKey = shown.leaving?.key;
    const done = () => setShown((value) => value.leaving?.key === leavingKey ? { ...value, leaving: null } : value);
    // The line itself moved to a new row in this commit (its layout place,
    // not the settle on top of it): it lands with the new label already on
    // it, and nothing fades at the old place.
    const top = tailLineTop(cell.current);
    if (top !== null && lineTop.current !== null && Math.abs(top - lineTop.current) > 1) {
      done();
      return;
    }
    const leaving = shown.leaving && nodes.current.get(shown.leaving.key);
    const entering = nodes.current.get(shown.key);
    if (leaving) {
      const exit = softExit(leaving);
      if (exit) exit.onfinish = done;
      else done();
    }
    // Tucked, the whole line already settles down its last few px into the new
    // row; the new call only fades in on it (offsets never add past the cap).
    if (entering) softEnter(entering, { delay: leaving ? SOFT_ENTER_DELAY_MS : 0, travel: tucked ? 0 : SOFT_ENTER_TRAVEL_PX });
    // Only a swap starts motion; the leaving item's removal does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.swap]);
  // The line moved to a new row while its new subject waited out the dwell:
  // it lands with that subject now (silently, below), not a moment later.
  // Every commit (a move can come in any); it settles at once: it only sets
  // the pending subject, after which `current` holds.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (current) return;
    const top = tailLineTop(cell.current);
    if (top === null || lineTop.current === null || Math.abs(top - lineTop.current) <= 1) return;
    setShown((value) => value.key === itemKey ? value
      : { key: itemKey, at: performance.now(), moved: true, swap: value.swap + 1, leaving: null });
  });
  // Where the line was last painted: a move and its new subject can land in
  // two commits before one paint (a message that appears reports so), and
  // that is still one move.
  useLayoutEffect(() => {
    if (lineTop.current === null) lineTop.current = tailLineTop(cell.current);
    const frame = requestAnimationFrame(() => { lineTop.current = tailLineTop(cell.current); });
    return () => cancelAnimationFrame(frame);
  });
  useEffect(() => {
    if (current || delay === 0) return;
    const timer = setTimeout(() => wake((value) => value + 1), delay);
    return () => clearTimeout(timer);
  }, [current, delay, itemKey]);
  const items: (TickerItem & { leaving: boolean })[] = [
    ...(shown.leaving ? [{ ...shown.leaving, leaving: true }] : []),
    { key: shown.key, node: current ? children : painted.current.node, leaving: false },
  ];
  return (
    // 20px tall in the 16px loader's 28px row: it overhangs the padding, not
    // the row, so the row keeps the timer's height. Clipped sideways only, so
    // the dissolve's few pixels of travel and blur are not cut off.
    <span ref={cell} className="-my-0.5 grid h-5 min-w-0 flex-1 overflow-x-clip" aria-live="off">
      {items.map((item) => (
        <span
          key={item.key}
          ref={(node) => { if (node) nodes.current.set(item.key, node); else nodes.current.delete(item.key); }}
          className={TICKER_ITEM}
          aria-hidden={item.leaving || undefined}
          data-loader-tick={item.leaving ? "out" : "in"}
        >
          {item.node}
        </span>
      ))}
    </span>
  );
}

/** The live tail line's layout offset in its feed (transforms excluded). */
function tailLineTop(cell: HTMLElement | null): number | null {
  const line = cell?.closest<HTMLElement>("[data-live-tail-line]");
  return line ? line.offsetTop : null;
}

/** How many GIBBERISH_THINKING_MS the turn has been running. */
const thinkingStep = (startedAt: number) =>
  Math.floor(Math.max(0, Date.now() - startedAt) / GIBBERISH_THINKING_MS);

/** The turn's gibberish thinking phrase: a new one every
 *  GIBBERISH_THINKING_MS, on the shared loader frame loop (which skips
 *  hidden retained surfaces). The sweep's cycle is locked to the phrase's,
 *  so each phrase shimmers once and changes as the light leaves it. 13px.
 *  Decorative: screen readers hear "Agent working", not nonsense. */
const GibberishThinking = memo(function GibberishThinking({ startedAt }: { startedAt: number }) {
  const scope = useContext(ActivityScope);
  const elRef = useRef<HTMLSpanElement | null>(null);
  const [step, setStep] = useState(() => thinkingStep(startedAt));
  const [delay] = useState(() => -Math.round(Math.max(0, Date.now() - startedAt) % GIBBERISH_THINKING_MS));
  useEffect(() => {
    const el = elRef.current;
    if (!el || scope === false) return;
    if (scope === true) return startElapsedDisplay({ host: el, startedAt, precision: () => GIBBERISH_THINKING_MS,
      format: elapsed => Math.floor(elapsed / GIBBERISH_THINKING_MS), changed: setStep,
      activity: active => {
        el.style.animationPlayState = active ? "" : "paused";
        // The phrase catches up to wall time on reveal. Resume its sweep at
        // that same phase instead of showing a new phrase mid-sweep.
        if (active) for (const animation of el.getAnimations())
          animation.currentTime = Math.max(0, Date.now() - startedAt + delay);
      } });
    // Same step, same state: React skips the render.
    return startLoaderRun({ host: el, tick: () => setStep(thinkingStep(startedAt)) });
  }, [startedAt, scope, delay]);
  return (
    <span
      ref={elRef}
      aria-hidden="true"
      className="zeros-gibberish-thinking text-xs whitespace-nowrap"
      style={{ animationDelay: `${delay}ms`, animationPlayState: scope === false ? "paused" : undefined }}
    >
      {gibberishThinking(startedAt, step)}
    </span>
  );
});

// --- RENDER ---
/** The caller owns when this live-only indicator mounts and unmounts. */
export const ActivityShimmer = memo(function ActivityShimmer({
  startedAt,
  className,
  gibberish = false,
  subject = null,
  bare = false,
  resetKey,
  tucked = false,
}: ActivityShimmerProps) {
  const timer = <WorkingDuration startedAt={startedAt} />;
  const idle = gibberish ? (
    <span className="flex min-w-0 items-center gap-2">
      <GibberishThinking startedAt={startedAt} />
      {timer}
    </span>
  ) : timer;
  return (
    <div
      className={cn(
        // The 16px loader hangs 2px into the gutter so it centres on the
        // feed's 12px icon column, and a 6px gap puts the timer 20px in, the
        // column every row label starts on.
        "text-fg2 flex items-center gap-1.5 py-1.5 text-xs",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <ZerosSpinner
        size={16}
        variant="glass"
        label="Agent working"
        className="-ml-0.5 shrink-0"
      />
      {bare ? null : (
        <LoaderTicker itemKey={subject?.key ?? TIMER_KEY} resetKey={resetKey} tucked={tucked}>
          {subject ? subject.label : idle}
        </LoaderTicker>
      )}
    </div>
  );
});
