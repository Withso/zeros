import { toast } from "../../shared/ui/primitives/elements/toast";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { useSessionsStore } from "./sessions-store";
import { logEvent } from "../../platform/observability/logging/renderer-log";

/** Closed renderer reasons. Queue readiness maps its terminal causes here. */
export type AgentSendFailureReason =
  | "queued_timeout"
  | "history_unavailable"
  | "workspace_start_timeout"
  | "workspace_stopped"
  | "user_stopped"
  | "workspace_archived"
  | "workspace_unavailable"
  | "unknown";

export interface AgentSendFailureInput {
  folder: string | null | undefined;
  chatId: string;
  /** The accepted message UUID, preserved when a queued message becomes a
   * turn. Before acceptance use the send command ID, never the error code. */
  attemptId: string;
  /** Explicit retry identity for diagnostics only; it never changes delivery. */
  diagnosticAttemptId?: string;
  agentId?: string | null;
  model?: string | null;
  error?: unknown;
  reason?: AgentSendFailureReason;
  /** Explicit per-message retry supplied by the queue owner, never an
   * automatic resend. Only readiness failures offer this action. */
  onRetry?: () => void;
}

// Event-owned acknowledgements survive chat remounts, reconnects and catalog
// revalidation for this renderer's lifetime. Only IDs are retained; history
// rendering never calls this helper or replays an action outcome.
const notified = new Set<string>();
const logged = new Set<string>();

function sendFailureReason(input: AgentSendFailureInput): AgentSendFailureReason {
  if (!isCloudWorkspace(input.folder)) return input.reason === "queued_timeout" ? input.reason : "unknown";
  return input.reason ?? "unknown";
}

/** Shared by direct and queued sends. Call only when an explicit attempt
 * fails, never from a render/effect or history hydration. Returns whether a
 * toast was emitted. */
export function notifyAgentSendFailure(input: AgentSendFailureInput): boolean {
  const reason = sendFailureReason(input);
  const key = JSON.stringify([input.folder ?? null, input.chatId, input.attemptId]);
  const diagnosticKey = JSON.stringify([input.folder ?? null, input.chatId, input.diagnosticAttemptId ?? input.attemptId]);
  if (isCloudWorkspace(input.folder) && !logged.has(diagnosticKey)) {
    logged.add(diagnosticKey);
    while (logged.size > 512) logged.delete(logged.values().next().value!);
    // Every explicit Not sent outcome is diagnosable, even when its persistent
    // card suppresses a toast. Never log prompt, path, IDs, credentials or prose.
    logEvent("agent_send_not_sent", { reason }, ["cloud", "agent"]);
  }
  // A failed queued send keeps its Not sent card as the sole error surface.
  if (isCloudWorkspace(input.folder)) {
    const slot = useSessionsStore.getState().sessions[input.chatId];
    if (slot?.cwd === input.folder && slot.cloudSendWait?.state === "failed" && slot.cloudSendWait.turnId &&
        slot.messages.some(message => message.id === slot.cloudSendWait?.turnId)) return false;
  }
  if (notified.has(key)) return false;
  notified.add(key);

  let message = "Message wasn't sent";
  let description: string | undefined = "Review the conversation before retrying.";
  let action: { label: string; onClick: () => void } | undefined;
  switch (reason) {
    case "history_unavailable":
      message = "Couldn't load chat history";
      description = "Your message is ready to retry.";
      break;
    case "workspace_start_timeout":
      message = "Workspace is still starting";
      description = "Your message wasn't sent. Retry when the workspace is ready.";
      break;
    case "queued_timeout":
      message = "Message wasn't sent in time";
      description = "Try sending again when the workspace is ready.";
      break;
    case "workspace_stopped":
      message = "Cloud workspace stopped";
      description = "Your message is ready to retry.";
      break;
    case "user_stopped":
      message = "Stopped before sending";
      description = "Your message is ready to retry.";
      break;
    case "workspace_archived":
      message = "Cloud workspace is archived";
      description = "Restore the workspace before sending again.";
      break;
    case "workspace_unavailable":
      message = "Cloud workspace is unavailable";
      description = "Try sending again when the workspace is ready.";
      break;
  }
  if (input.onRetry && ["queued_timeout", "history_unavailable", "workspace_start_timeout", "workspace_stopped", "workspace_unavailable"].includes(reason)) {
    action = { label: "Retry", onClick: input.onRetry };
  }
  toast.error(message, { id: `agent-send-failure:${key}`, description, action });
  return true;
}
