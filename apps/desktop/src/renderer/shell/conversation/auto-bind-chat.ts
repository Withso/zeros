import type { BridgeRegistryAgent } from "../../platform/bridge/messages";
import { newChatBornDefaults } from "../../features/agent/new-chat-defaults";
import { isAgentEnabled } from "../../features/agent/enabled-agents";
import { agentFamily } from "../../features/agent/model-catalog";
import {
  FALLBACK_NEW_CHAT_AGENT_ID,
  pickAgentForNewChat,
} from "../../features/settings/default-agent";
import type { ChatThread } from "../../state/store";

export type AutoBindChatSettings = Pick<
  ChatThread,
  "agentId" | "agentName" | "model" | "effort" | "fast" | "permissionMode"
> &
  Pick<ChatThread, "sessionId" | "lastModeId" | "prePlanModeId">;

/** What an unbound chat still remembers about the agent it used to run. A
 *  persisted row that lost its `agentId` (a pre-binding record, a corrupted
 *  migration) usually kept `agentName`, and that name is exactly as
 *  trustworthy as the id was — both were written in the same update. */
export interface PriorChatIdentity {
  agentName?: string | null;
  sessionId?: string | null;
}

/**
 * Resolve the complete born configuration for an unbound chat.
 *
 * A null registry is still loading — the caller waits (bounded by the
 * agents-cache timeout, which publishes `[]` on failure) instead of guessing
 * an agent and permanently binding a mismatched model/configuration snapshot.
 *
 * A LOADED registry always resolves. "Every chat always has an agent" is the
 * product rule and the composer is the recovery surface: a not-signed-in or
 * not-installed binding renders a live composer whose spawn/sign-in flow is
 * actionable, where an unbound chat renders a dead pane. So once `agents` is
 * non-null this returns the best available binding — enabled+runnable first,
 * then enabled+installed (sign-in pending), then enabled, then anything
 * listed, then the hardcoded product default for an empty registry.
 *
 * `prior` lets a chat that merely LOST its binding land back on its own agent
 * instead of the global default, which is also what makes its `sessionId` safe
 * to keep: a session id is agent-scoped, so it survives only when the resolved
 * agent is the same family that minted it. Resuming Claude's id on Codex would
 * fail the load and strand the chat in an error state, so every other case
 * clears it and starts fresh (the chat's own message history lives in the app
 * database and is untouched either way).
 */
export function resolveAutoBindChatSettings(
  agents: BridgeRegistryAgent[] | null,
  preferredAgentId?: string | null,
  isEnabled: (id: string, beta?: boolean) => boolean = isAgentEnabled,
  prior: PriorChatIdentity = {},
): AutoBindChatSettings | null {
  if (!agents) return null;
  // The chat's own prior agent outranks the global star: rebinding a repaired
  // record onto a different provider than it ran on is a bigger surprise than
  // ignoring the default for this one chat.
  const priorFamily = agentFamily(prior.agentName ?? null);
  const agent = pickAgentForNewChat(
    agents,
    priorFamily || (preferredAgentId ?? null),
    isEnabled,
  );
  const agentId = agent?.id ?? FALLBACK_NEW_CHAT_AGENT_ID;
  // An empty priorFamily means the old agent is unidentifiable, so it can
  // never vouch for the session id — two family-less ids are not a match.
  const keepsSession =
    Boolean(prior.sessionId) &&
    priorFamily !== "" &&
    priorFamily === agentFamily(agentId);
  return {
    agentId,
    agentName: agent?.name ?? null,
    ...newChatBornDefaults(agentId),
    sessionId: keepsSession ? (prior.sessionId ?? undefined) : undefined,
    prePlanModeId: undefined,
  };
}
