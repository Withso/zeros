import type { AgentFailure } from "../../platform/bridge/failure";

/** Stop reasons where the agent itself finished the turn (possibly at a
 * limit): its answer is complete and may finish revealing in place. */
const NATURAL_STOP_REASONS = new Set(["end_turn", "max_tokens", "max_turn_requests", "budget_exhausted"]);

/** Whether a turn that just stopped being live ended naturally. A Stop, an
 * error, an interruption, or an outcome not known yet all count as not
 * natural: the message is then simply complete at once, never animating
 * after a Stop. */
export function turnEndedNaturally({ stopReason, failure, cancelled }: {
  stopReason: string | null | undefined;
  failure: AgentFailure | null | undefined;
  /** The prompt's own receipt says cancelled, or the turn stopped for sign-in. */
  cancelled: boolean;
}): boolean {
  return !cancelled && !failure && !!stopReason && NATURAL_STOP_REASONS.has(stopReason);
}
