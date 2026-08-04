// ──────────────────────────────────────────────────────────
// LiveDuration + DurationChip — shared duration UI
// ──────────────────────────────────────────────────────────
//
// Stage 5.1 — every in-progress tool card needs a ticking
// elapsed counter so a long-running shell/read/fetch/etc.
// doesn't look frozen.
//
// Two exports:
//   - LiveDuration({ startedAt }) — re-renders once per
//     second; shows tabular-num formatted elapsed time.
//   - DurationChip({ status, startedAt, durationMs }) —
//     renders LiveDuration while in_progress, formatted
//     final duration once the card completes (only if
//     duration > 250ms — short ops don't warrant a chip).
//
// Phase 9.D (2026-05-16) — chrome migrated from .zeros-agent-
// live-duration / .zeros-agent-final-duration CSS classes to
// Tailwind utilities + a tiny .zeros-agent-live-duration class
// that ONLY carries the @keyframes pulse animation. The animation
// stays in CSS because Tailwind v4 doesn't have a token for the
// custom 1.6s ease-in-out infinite opacity pulse.
// ──────────────────────────────────────────────────────────

import { memo, useEffect, useRef, useState } from "react";

import { cn } from "@/zeros/ui/cn";
import { isElementActuallyVisible } from "@/zeros/utils/element-visibility";

// Shared utility classes — kept as module constants so consumers
// composing their own className don't have to redefine the base.
const LIVE_DURATION_CLS =
  "zeros-agent-live-duration text-xs tabular-nums text-blue-primary";
const FINAL_DURATION_CLS =
  "text-xs tabular-nums text-fg3";

interface LiveDurationProps {
  startedAt: number;
  className?: string;
}

export const LiveDuration = memo(function LiveDuration({
  startedAt,
  className,
}: LiveDurationProps) {
  // 1 Hz tick. Sub-second precision in the display would just thrash
  // React with no informational gain — what users want to know is
  // "is this still running" and "is it taking a long time", both
  // answered fine at 1s granularity.
  const [tick, setTick] = useState(0);
  const elRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      // Retained-but-hidden chat decks keep this component mounted
      // (visibility:hidden), and N streaming tool cards across those decks
      // would otherwise each re-render every second while invisible. The
      // elapsed value is derived from startedAt at render time, so skipped
      // ticks cost nothing: the first visible tick shows the correct total.
      const el = elRef.current;
      if (el && !isElementActuallyVisible(el)) return;
      setTick((t) => t + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);
  // tick is read only to satisfy the linter — the increment alone is
  // what schedules a re-render.
  void tick;
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  return (
    <span ref={elRef} className={cn(LIVE_DURATION_CLS, className)}>
      {formatElapsed(elapsedMs)}
    </span>
  );
});

interface DurationChipProps {
  status: "pending" | "in_progress" | "completed" | "failed";
  startedAt: number;
  durationMs: number;
  /** className applied in both states. Defaults to a sane shared one. */
  className?: string;
  /** Threshold below which a finished card hides its duration chip
   *  entirely. Tunes how chatty the card chrome is on fast ops. */
  hideBelowMs?: number;
}

export const DurationChip = memo(function DurationChip({
  status,
  startedAt,
  durationMs,
  className,
  hideBelowMs = 250,
}: DurationChipProps) {
  if (status === "in_progress" || status === "pending") {
    return <LiveDuration startedAt={startedAt} className={className} />;
  }
  if (durationMs <= hideBelowMs) return null;
  return (
    <span className={cn(FINAL_DURATION_CLS, className)}>
      {formatElapsed(durationMs)}
    </span>
  );
});

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
