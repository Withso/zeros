import type { AgentSessionState } from "./use-agent-session";
import { agentFamily } from "./model-catalog";

export type AgentActivity = "running" | "waiting" | null;

/** Codex and Cursor retain their foreground-only chat-tab indicator. Their
 * native background process tracking still participates in workspace safety. */
export function chatAgentActivity(
  slot: AgentSessionState | undefined,
  pendingLocalTurnId?: string | null,
): AgentActivity {
  return agentFamily(slot?.agentId ?? null) === "claude"
    ? agentActivity(slot, pendingLocalTurnId)
    : slot?.status === "streaming"
      ? "running"
      : null;
}

/** Shared by the transcript and tabs. A settled send and a live Claude
 * continuation are independent; task/child traffic alone is not parent work. */
export function agentActivity(
  slot: AgentSessionState | undefined,
  pendingLocalTurnId?: string | null,
): AgentActivity {
  if (pendingLocalTurnId) return "running";
  if (!slot) return null;
  const claude = agentFamily(slot.agentId) === "claude";
  // Claude can hold the SDK Result while children finish. A native end_turn
  // parks only the parent presentation; the outstanding send stays cancellable.
  if (slot.status === "streaming") {
    return claude &&
      slot.waitingForBackgroundTasks &&
      slot.backgroundTasks.length > 0 &&
      slot.backgroundActivity?.state === "idle"
      ? "waiting"
      : "running";
  }
  if (slot.lastStopReason === "cancelled") return null;
  if (
    (slot.status === "warming" || slot.status === "reconnecting") &&
    slot.activeTurnStartedAt !== null
  )
    return "running";
  if (
    claude &&
    slot.backgroundActivity &&
    slot.backgroundActivity.state !== "idle"
  )
    return "running";
  if (slot.workflows.some((workflow) => workflow.status === "running"))
    return "running";
  if (slot.backgroundTasks.length > 0) {
    return claude && slot.waitingForBackgroundTasks ? "waiting" : "running";
  }
  return null;
}

export function combinedAgentActivity(
  activities: Iterable<AgentActivity>,
): AgentActivity {
  let result: AgentActivity = null;
  for (const activity of activities) {
    if (activity === "running") return activity;
    if (activity === "waiting") result = activity;
  }
  return result;
}
