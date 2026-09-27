import type {
  AgentSessionCreatedMessage,
  AgentSessionLoadedMessage,
} from "../../platform/bridge/messages";
import { parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import type { AgentSessionState } from "./use-agent-session";

/** A cloud attachment outlives its command executions. Their real admission
 * metadata updates the existing slot without resetting its transcript or turn. */
export function cloudSessionMetadata(
  slot: AgentSessionState | undefined,
  message: AgentSessionCreatedMessage | AgentSessionLoadedMessage,
): Partial<AgentSessionState> | null {
  const metadata =
    message.type === "AGENT_SESSION_CREATED"
      ? message.session
      : message.response;
  const executionId =
    message.type === "AGENT_SESSION_CREATED"
      ? (message.session.executionId ?? message.session.sessionId)
      : (message.executionId ?? message.sessionId);
  if (
    !slot ||
    !parseCloudScopedId(executionId) ||
    (slot.executionId ?? slot.sessionId) !== executionId ||
    slot.agentId !== message.agentId
  )
    return null;
  return {
    session: {
      ...slot.session,
      ...metadata,
      executionId,
      sessionId: executionId,
    },
    ...(message.type === "AGENT_SESSION_CREATED"
      ? { initialize: message.initialize }
      : {}),
    ...(metadata.providerBinding
      ? { providerBinding: metadata.providerBinding }
      : {}),
    ...(metadata.providerMetadata
      ? { providerMetadata: metadata.providerMetadata }
      : {}),
    ...(metadata.boundary ? { boundary: metadata.boundary } : {}),
    ...(metadata.boundaryPorts
      ? { boundaryPorts: metadata.boundaryPorts }
      : {}),
    ...(metadata.modes
      ? {
          availableModes: metadata.modes.availableModes,
          currentModeId: metadata.modes.currentModeId,
        }
      : {}),
  };
}
