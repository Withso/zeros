import { useLayoutEffect, useMemo, useRef } from "react";
import type { AgentMessage } from "./use-agent-session";
import { partitionTurnSequence, type TurnSegment } from "./turn-partition";

/** Preserve disclosure identities against the last committed exact-owner
 * snapshot. Retain only this mounted feed's current sequence; no additional
 * history, DOM, subscriptions or offscreen work is kept alive. */
export function useTurnSequence(
  events: AgentMessage[],
  live: boolean,
  owner: string | null,
  failureTurnId?: string,
): TurnSegment[] {
  const committed = useRef<{
    owner: string | null;
    sequence: TurnSegment[];
  } | null>(null);
  const sequence = useMemo(
    () =>
      partitionTurnSequence(
        events,
        { live, failureTurnId },
        committed.current && committed.current.owner === owner
          ? committed.current.sequence
          : undefined,
      ),
    [events, live, owner, failureTurnId],
  );
  // An abandoned concurrent render must not become the identity baseline.
  useLayoutEffect(() => {
    committed.current = { owner, sequence };
  }, [owner, sequence]);
  return sequence;
}
