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

/** The anchor for a streaming turn's live elapsed timer: the EARLIEST moment
 *  the turn is known to have started.
 *
 *  This clock answers exactly one question — "how long have I been waiting for
 *  this turn?" — so it must only ever go up. It used to re-anchor to the most
 *  recent in-flight tool, which made it read 0s at the start of every tool and
 *  jump back to the real elapsed the moment that tool finished: a visible
 *  reset-and-resume several times per turn, on every provider. (Per-tool
 *  elapsed is not lost — each in-flight tool row renders its own DurationChip,
 *  where a tool-scoped clock is the right answer.)
 *
 *  Two candidate anchors, and the earliest wins:
 *   - the turn's own start (the user message's timestamp) — authoritative when
 *     the caller has it; callers pass 0 for "no user message in this turn
 *     yet", which is a sentinel, not a timestamp, and would date the clock to
 *     the epoch.
 *   - the first provider event — only a PROXY, because events are stamped when
 *     the renderer RECEIVES them. On a slow first token (Cursor's cold session
 *     routinely takes 10s+) it lands ten seconds after the send, so taking it
 *     verbatim made the timer count to 12s, snap to 0s as the first frame
 *     arrived, and settle at ~1s for a 13s turn. */
export function pickStartedAt(
  events: AgentMessage[],
  fallbackStartedAt?: number,
): number {
  const turnStartedAt =
    typeof fallbackStartedAt === "number" && fallbackStartedAt > 0
      ? fallbackStartedAt
      : null;
  const firstEventAt = events.length > 0 ? events[0].createdAt : null;
  if (turnStartedAt !== null && firstEventAt !== null) {
    return Math.min(turnStartedAt, firstEventAt);
  }
  return turnStartedAt ?? firstEventAt ?? Date.now();
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
