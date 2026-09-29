// ============================================
// COMPONENT: ActivityShimmer
// PURPOSE: Show the agent at work (the glass square) with its working timer
//          and, when opted in, its gibberish thinking phrase.
// USED IN: The active agent turn's trailing activity row.
// ============================================

// --- IMPORTS ---
import { memo, useEffect, useRef, useState } from "react";

import { cn } from "@/renderer/shared/ui/cn";

import { GIBBERISH_THINKING_MS, gibberishThinking } from "./gibberish-thinking";
import { WorkingDuration } from "./live-duration";
import { startLoaderRun } from "./loader-loop";
import { ZerosSpinner } from "./zeros-spinner";

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
  const elRef = useRef<HTMLSpanElement | null>(null);
  const [step, setStep] = useState(() => thinkingStep(startedAt));
  const [delay] = useState(() => -Math.round(Math.max(0, Date.now() - startedAt) % GIBBERISH_THINKING_MS));
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    // Same step, same state: React skips the render.
    return startLoaderRun({ host: el, tick: () => setStep(thinkingStep(startedAt)) });
  }, [startedAt]);
  return (
    <span
      ref={elRef}
      aria-hidden="true"
      className="zeros-gibberish-thinking text-xs whitespace-nowrap"
      style={{ animationDelay: `${delay}ms` }}
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
}: ActivityShimmerProps) {
  const timer = <WorkingDuration startedAt={startedAt} />;
  return (
    <div
      className={cn(
        "text-fg2 flex items-center gap-3 py-1.5 text-xs",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <ZerosSpinner
        size={16}
        variant="glass"
        label="Agent working"
        className="shrink-0"
      />
      {gibberish ? (
        <span className="flex min-w-0 items-center gap-2">
          <GibberishThinking startedAt={startedAt} />
          {timer}
        </span>
      ) : (
        timer
      )}
    </div>
  );
});
