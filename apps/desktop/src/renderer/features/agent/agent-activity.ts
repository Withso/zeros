import type { AgentSessionState } from "./use-agent-session";
import { agentFamily } from "./model-catalog";

export type AgentActivity = "running" | "waiting" | null;

/** Codex and Cursor retain their foreground-only chat-tab indicator. Their
 * native background process tracking still participates in workspace safety.
 * A send this renderer has in flight is foreground work for every agent, so a
 * tab starts working the moment its message is sent, even while the session
 * is still warming up. */
export function chatAgentActivity(
  slot: AgentSessionState | undefined,
  pendingLocalTurnId?: string | null,
): AgentActivity {
  if (pendingLocalTurnId) return "running";
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

/** True while a chat's turn is parked on the user: a blocking question
 * (Claude's AskUserQuestion, Codex's request_user_input, an MCP form), a
 * permission gate or a plan review waits for an answer, and the turn cannot
 * move until it comes. Codex's async questions don't park: the agent keeps
 * working while they wait. A running multi-agent workflow keeps the session
 * working beside the ask. Cursor's SDK never asks. */
export function parkedOnUser(slot: AgentSessionState | undefined): boolean {
  if (!slot) return false;
  const asking =
    slot.pendingPermission !== null ||
    slot.pendingQuestions.some((entry) => entry.request.blocking);
  if (!asking) return false;
  return !slot.workflows.some((workflow) => workflow.status === "running");
}

/** The activity a workspace's square shows: the chat's agent activity, at
 * rest while its turn is parked on the user. */
export function workingActivity(
  slot: AgentSessionState | undefined,
  pendingLocalTurnId?: string | null,
): AgentActivity {
  return parkedOnUser(slot) ? null : agentActivity(slot, pendingLocalTurnId);
}

/** The chat-tab variant of {@link workingActivity}. */
export function chatWorkingActivity(
  slot: AgentSessionState | undefined,
  pendingLocalTurnId?: string | null,
): AgentActivity {
  return parkedOnUser(slot) ? null : chatAgentActivity(slot, pendingLocalTurnId);
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
