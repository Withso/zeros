// ──────────────────────────────────────────────────────────
// Agent activity timing helpers and retired ActivityHUD compatibility shim
// ──────────────────────────────────────────────────────────
//
// The canonical ActivityShimmer implementation lives with every other loader
// in apps/desktop/src/renderer/shared/ui/loading. This feature module owns only AgentMessage-specific start-time
// selection and the retired ActivityHUD export.
// ──────────────────────────────────────────────────────────

import { memo } from "react";

import { ActivityShimmer, LiveDuration } from "@/renderer/shared/ui/loading";
import type { AgentMessage } from "./use-agent-session";

/** Convenience: compute the best startedAt for a streaming turn.
 *  Walks backwards from the events to find the most recent
 *  in_progress/pending tool; falls back to the turn's earliest event
 *  start time, then to Date.now(). */
export function pickStartedAt(
  events: AgentMessage[],
  fallbackStartedAt?: number,
): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const m = events[i];
    if (
      m.kind === "tool" &&
      (m.status === "in_progress" || m.status === "pending")
    ) {
      return m.createdAt;
    }
  }
  // Fall back: pick the earliest event so the duration reflects "how
  // long this turn has been going" rather than "0s" between tools.
  if (events.length > 0) {
    return events[0].createdAt;
  }
  return fallbackStartedAt ?? Date.now();
}

interface ActivityHUDProps {
  messages: AgentMessage[];
  isStreaming: boolean;
}

/** Back-compat shim — the old prop shape called this `ActivityHUD`.
 *  Returns null because the indicator now mounts inline at the tail
 *  of the active turn (turn-event-list.tsx), not above the composer.
 *  Kept as a compatibility export for older call sites. */
export const ActivityHUD = memo(function ActivityHUD(_props: ActivityHUDProps) {
  return null;
});

// Back-compat re-exports; canonical implementations live in apps/desktop/src/renderer/shared/ui/loading.
export { ActivityShimmer, LiveDuration };
