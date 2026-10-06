import { toast } from "../../shared/ui/primitives/elements/toast";
import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { cloudCatalogGeneration, cloudWorkspaceDocument } from "../../state/cloud-workspace-catalog";
import { cloudWorkspaceRestartVisible, restartCloudWorkspace } from "../../state/cloud-workspace-restart";
import { isInternalFeatureActive } from "../settings/internal-features";
import { classifyCloudAdmissionFailure, cloudAdmissionFailureCode } from "./cloud-admission-failure";
import { openCloudAdmissionSettings } from "./cloud-admission-status";
import { modelsForAgent } from "./model-catalog";

export const CLOUD_RUNTIME_UPGRADE_TOOLTIP = "Gets the new cloud runtime the next time this workspace wakes";

/** Closed renderer reasons. Queue readiness maps its terminal causes here;
 * direct sends can instead supply an exact admission code in `error`. */
export type AgentSendFailureReason =
  | "queued_timeout"
  | "workspace_stopped"
  | "workspace_archived"
  | "workspace_unavailable"
  | "runtime_upgrade_required"
  | "model_not_enabled"
  | "credential_missing"
  | "credential_expired_or_revoked"
  | "credential_refresh_required"
  | "dispatch_ambiguous"
  | "unknown";

export interface AgentSendFailureInput {
  folder: string | null | undefined;
  chatId: string;
  /** The accepted message UUID, preserved when a queued message becomes a
   * turn. Before acceptance use the send command ID, never the error code. */
  attemptId: string;
  agentId?: string | null;
  model?: string | null;
  error?: unknown;
  reason?: AgentSendFailureReason;
  /** Explicit per-message retry supplied by the queue owner, never an
   * automatic resend. Only readiness failures offer this action. */
  onRetry?: () => void;
  /** Optional runtime-owner override; otherwise uses the shared explicit
   * stop → wake action. Both paths require cloud workspace run access. */
  onRestartWorkspace?: () => void;
}

// Event-owned acknowledgements survive chat remounts, reconnects and catalog
// revalidation for this renderer's lifetime. Only IDs are retained; history
// rendering never calls this helper or replays an action outcome.
const notified = new Set<string>();

function sendFailureReason(input: AgentSendFailureInput): AgentSendFailureReason | null {
  if (!isCloudWorkspace(input.folder)) return input.reason === "queued_timeout" ? input.reason : "unknown";
  // The command receipt's exact admission cause wins over a queue/dispatch fallback.
  const failure = classifyCloudAdmissionFailure({ ...input, error: input.error });
  switch (failure?.kind) {
    case "waiting": return input.reason ?? null;
    case "runtime-upgrade-required": return "runtime_upgrade_required";
    case "model-not-authorized": return "model_not_enabled";
    case "credential-required":
      switch (cloudAdmissionFailureCode(input.error)) {
        case "cloud_agent_credential_expired":
        case "cloud_agent_credential_revoked": return "credential_expired_or_revoked";
        case "cloud_agent_credential_refresh_required": return "credential_refresh_required";
        default: return "credential_missing";
      }
    case "unavailable": return input.reason ?? "dispatch_ambiguous";
    default: return input.reason ?? "unknown";
  }
}

function runtimeRestartAction(input: AgentSendFailureInput) {
  const target = parseCloudWorkspaceKey(input.folder);
  if (!target) return undefined;
  const canRestart = () => {
    const workspace = cloudWorkspaceDocument(target);
    return isInternalFeatureActive("cloudComputerV2") && workspace?.capabilities.canWrite &&
      cloudWorkspaceRestartVisible(input.folder!, workspace);
  };
  if (!canRestart()) return undefined;
  const account = cloudCatalogGeneration();
  const onRestartWorkspace = input.onRestartWorkspace ?? (() => {
    // The shared restart owner presents lifecycle failures once.
    void restartCloudWorkspace(target).catch(() => {});
  });
  return { label: "Restart workspace", onClick: () => {
    if (account === cloudCatalogGeneration() && canRestart()) onRestartWorkspace();
  } };
}

/** Shared by direct and queued sends. Call only when an explicit attempt
 * fails, never from a render/effect or history hydration. Returns whether a
 * toast was emitted. Waiting leaves the message identity unconsumed. */
export function notifyAgentSendFailure(input: AgentSendFailureInput): boolean {
  const reason = sendFailureReason(input);
  if (reason === null) return false;
  const key = JSON.stringify([input.folder ?? null, input.chatId, input.attemptId]);
  if (notified.has(key)) return false;
  notified.add(key);

  let message = "Message wasn't sent";
  let description: string | undefined = "Review the conversation before retrying.";
  let action: { label: string; onClick: () => void } | undefined;
  const provider = input.agentId === "codex" ? "Codex" : input.agentId === "claude" ? "Claude Code" : input.agentId === "cursor" ? "Cursor" : "agent";
  switch (reason) {
    case "queued_timeout":
      message = "Message wasn't sent in time";
      description = "Try sending again when the workspace is ready.";
      break;
    case "workspace_stopped":
      message = "Cloud workspace stopped";
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
    case "runtime_upgrade_required":
      message = "This workspace is on an older runtime";
      action = runtimeRestartAction(input);
      description = action ? "Restart this workspace to update its cloud runtime." : CLOUD_RUNTIME_UPGRADE_TOOLTIP;
      break;
    case "model_not_enabled": {
      const model = input.agentId && input.model ? modelsForAgent(input.agentId, null).find(row => row.value === input.model)?.label : null;
      message = `${model ?? "The selected model"} isn't enabled for this workspace`;
      description = undefined;
      if (input.agentId) action = { label: "Agent settings", onClick: () => openCloudAdmissionSettings(input.folder, input.agentId) };
      break;
    }
    case "credential_missing":
    case "credential_expired_or_revoked":
    case "credential_refresh_required":
      message = reason === "credential_missing" ? `Connect ${provider} to send messages`
        : reason === "credential_refresh_required" ? `Your ${provider} connection needs to be renewed`
        : `Reconnect ${provider} to send messages`;
      description = undefined;
      if (input.agentId) action = { label: "Reconnect", onClick: () => openCloudAdmissionSettings(input.folder, input.agentId) };
      break;
    case "dispatch_ambiguous":
      message = "Cloud request couldn't be completed";
      break;
  }
  if (input.onRetry && ["queued_timeout", "workspace_stopped", "workspace_unavailable"].includes(reason)) {
    action = { label: "Retry", onClick: input.onRetry };
  }
  toast.error(message, { id: `agent-send-failure:${key}`, description, action });
  return true;
}
