import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { modelsForAgent } from "./model-catalog";
import { CLOUD_WORKSPACE_V2_REQUIRED_MESSAGE } from "../../platform/cloud-workspace-execution";

export type CloudAdmissionFailure = {
  kind: "runtime-upgrade-required" | "retired-runtime" | "model-not-authorized" | "credential-required" | "waiting" | "unavailable";
  message: string;
  action: "none" | "choose-model" | "reconnect" | "retry";
};

export type CloudAdmissionState = CloudAdmissionFailure & {
  code: string;
  turnId: string;
  agentId: string;
  model: string | null;
};
export function cloudAdmissionFailureCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? error.code : error instanceof Error ? error.message : error;
}

/** Exact closed causes only. Local/provider failures retain their own handling;
 * waiting is consumed by the cloud preparation queue, never an error toast. */
export function classifyCloudAdmissionFailure(input: {
  folder: string | null | undefined;
  error: unknown;
  model?: string | null;
  agentId?: string | null;
}): CloudAdmissionFailure | null {
  if (!isCloudWorkspace(input.folder)) return null;
  const code = cloudAdmissionFailureCode(input.error);
  const provider = input.agentId === "codex" ? "Codex" : input.agentId === "claude" ? "Claude Code" : input.agentId === "cursor" ? "Cursor" : "your agent";
  switch (code) {
    case "cloud_workspace_v2_required":
      return { kind: "retired-runtime", message: CLOUD_WORKSPACE_V2_REQUIRED_MESSAGE, action: "none" };
    case "cloud_runtime_upgrade_required":
      return { kind: "runtime-upgrade-required", message: "This workspace gets the new cloud runtime the next time it wakes", action: "none" };
    case "cloud_agent_model_not_authorized": {
      const model = input.agentId && input.model ? modelsForAgent(input.agentId, null).find(row => row.value === input.model)?.label ?? input.model : "The selected model";
      return { kind: "model-not-authorized", message: `${model} isn't enabled for this workspace`, action: "choose-model" };
    }
    case "cloud_agent_credential_required":
      return { kind: "credential-required", message: `Connect ${provider} to use agents in this workspace`, action: "reconnect" };
    case "cloud_agent_credential_expired":
      return { kind: "credential-required", message: `Your ${provider} connection expired. Reconnect to continue`, action: "reconnect" };
    case "cloud_agent_credential_refresh_required":
      return { kind: "credential-required", message: `Your ${provider} connection needs to be renewed. Reconnect to continue`, action: "reconnect" };
    case "cloud_agent_credential_revoked":
      return { kind: "credential-required", message: `Your ${provider} connection was disconnected. Reconnect to continue`, action: "reconnect" };
    case "cloud_workspace_not_ready":
    case "cloud_workspace_waking":
    case "CLOUD_WORKSPACE_CHECKPOINTING":
    case "CLOUD_WORKSPACE_NOT_READY":
      return { kind: "waiting", message: "Waiting for agent", action: "none" };
    // Compatibility: the cloud receipt observer emits this exact legacy
    // sentinel for an uncertain command. Never match arbitrary provider prose.
    case "command_dispatch_rejected":
    case "cloud_agent_authority_rejected":
    case "The cloud command outcome is unknown. Review the transcript before retrying.":
      return { kind: "unavailable", message: "The cloud agent request could not be completed. Review the conversation before trying again", action: "none" };
    default:
      return null;
  }
}

/** A saved refusal belongs to one user turn, not the chat's next provider turn. */
export function cloudAdmissionForTurn(input: {
  folder: string | null | undefined;
  turnId: string | null | undefined;
  recoveryFailure?: { kind: string; message: string };
  current?: CloudAdmissionState | null;
  agentId?: string | null;
}): CloudAdmissionFailure | null {
  if (!isCloudWorkspace(input.folder)) return null;
  const current = input.current && input.current.turnId === input.turnId && input.current.kind !== "unavailable" ? input.current : null;
  return classifyCloudAdmissionFailure({ folder: input.folder,
    error: input.recoveryFailure?.kind === "cloud-admission" ? input.recoveryFailure.message : current?.code,
    agentId: current?.agentId ?? input.agentId, model: current?.model });
}
