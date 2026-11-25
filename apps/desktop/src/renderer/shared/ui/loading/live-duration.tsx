// ──────────────────────────────────────────────────────────
// WorkingDuration — the agent's working timer
// ──────────────────────────────────────────────────────────
//
// The active turn's rail counts in tenths of a second (57.5s · 1m 27.3s ·
// 103m 57.5s), so it visibly runs, at 12px in plain --fg2 with no pulse.
// The per-tool LiveDuration and DurationChip were removed on 2026-11-25:
// nothing rendered them any more.
// ──────────────────────────────────────────────────────────

import { memo, useContext, useEffect, useRef, useState } from "react";

import { cn } from "@/renderer/shared/ui/cn";

import { startLoaderRun } from "./loader-loop";
import { ActivityScope } from "./activity-scope";
import { startElapsedDisplay } from "./elapsed-display";

interface WorkingDurationProps {
  startedAt: number;
  className?: string;
}

/** The agent's working timer (ActivityShimmer, the active turn's rail). It
 *  re-renders only when the tenth changes, from the shared loader frame loop,
 *  which skips hidden retained surfaces, so a background chat stays inert and
 *  no tenth is skipped. Its ticks are not announced: the rail is a live
 *  region, and ten updates a second would drown a screen reader. */
export const WorkingDuration = memo(function WorkingDuration({
  startedAt,
  className,
}: WorkingDurationProps) {
  const scope = useContext(ActivityScope);
  const elRef = useRef<HTMLSpanElement | null>(null);
  const [text, setText] = useState(() => formatWorkingElapsed(Date.now() - startedAt));
  useEffect(() => {
    const el = elRef.current;
    if (!el || scope === false) return;
    if (scope === true) return startElapsedDisplay({ host: el, startedAt, precision: () => 100,
      format: formatWorkingElapsed, changed: setText });
    return startLoaderRun({
      host: el,
      // Same text, same state: React skips the render.
      tick: () => setText(formatWorkingElapsed(Date.now() - startedAt)),
    });
  }, [startedAt, scope]);
  return (
    <span ref={elRef} aria-live="off" className={cn("text-3xxs tabular-nums text-fg2", className)}>
      {text}
    </span>
  );
});

export function formatWorkingElapsed(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  const minutes = Math.floor(tenths / 600);
  const rest = tenths % 600;
  const seconds = `${Math.floor(rest / 10)}.${rest % 10}s`;
  return minutes ? `${minutes}m ${seconds}` : seconds;
}

/** Compact human-readable elapsed format: 4s · 12s · 1m 4s · 12m 30s · 1h 20m. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) {
    // Sub-second only fires for the very first paint of a long op,
    // before the 1Hz tick has had a chance. Show "0s" rather than
    // jumping the chip width by a couple of pixels going from "0ms"
    // to "1s".
    return "0s";
  }
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}
