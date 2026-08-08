import type { BridgeRegistryAgent } from "../../platform/bridge/messages";
import { newChatBornDefaults } from "../../features/agent/new-chat-defaults";
import { isAgentEnabled } from "../../features/agent/enabled-agents";
import {
  agentFamily,
  agentSupportsFast,
  effectiveEffort,
  modelsForAgent,
} from "../../features/agent/model-catalog";
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
 *  trustworthy as the id was — both were written in the same update. The
 *  composer configuration travels with it: `sanitizeCachedChat` preserves
 *  `model`/`effort`/`fast`/`permissionMode` while nulling `agentId`, and those
 *  fields are agent-scoped in precisely the way `sessionId` is. */
export interface PriorChatIdentity {
  agentName?: string | null;
  sessionId?: string | null;
  model?: string | null;
  effort?: ChatThread["effort"];
  fast?: boolean;
  permissionMode?: ChatThread["permissionMode"];
  lastModeId?: string | null;
}

/**
 * Resolve the complete born configuration for an unbound chat.
 *
 * This NEVER waits. A null registry means the shared snapshot has nothing yet
 * (a true first run — the cache hydrates from localStorage at module load), so
 * resolution falls through the same product chain an empty registry uses. The
 * caller renders the composer immediately against that guess and reconciles it
 * once the live list lands; gating the first paint on the round trip would hide
 * a data waterfall behind a spinner.
 *
 * "Every chat always has an agent" is the product rule and the composer is the
 * recovery surface: a not-signed-in or not-installed binding renders a live
 * composer whose spawn/sign-in flow is actionable, where an unbound chat
 * renders a dead pane. So this returns the best available binding — enabled +
 * runnable first, then enabled+installed (sign-in pending), then enabled, then
 * anything listed, then the hardcoded product default for an empty registry.
 *
 * `prior` lets a chat that merely LOST its binding land back on its own agent
 * instead of the global default, which is also what makes the rest of its
 * record safe to keep: a session id is agent-scoped, so it survives only when
 * the resolved agent is the same family that minted it. Resuming Claude's id on
 * Codex would fail the load and strand the chat in an error state, so every
 * other case clears it and starts fresh (the chat's own message history lives
 * in the app database and is untouched either way). Its model/effort/Fast and
 * permission posture ride the same rule: repairing a record must not silently
 * move the chat onto the global default model when the family it already ran on
 * is what it lands back on.
 */
export function resolveAutoBindChatSettings(
  agents: BridgeRegistryAgent[] | null,
  preferredAgentId?: string | null,
  isEnabled: (id: string, beta?: boolean) => boolean = isAgentEnabled,
  prior: PriorChatIdentity = {},
): AutoBindChatSettings {
  // The chat's own prior agent outranks the global star: rebinding a repaired
  // record onto a different provider than it ran on is a bigger surprise than
  // ignoring the default for this one chat.
  const priorFamily = agentFamily(prior.agentName ?? null);
  const agent = pickAgentForNewChat(
    agents ?? [],
    priorFamily || (preferredAgentId ?? null),
    isEnabled,
  );
  const agentId = agent?.id ?? FALLBACK_NEW_CHAT_AGENT_ID;
  // An empty priorFamily means the old agent is unidentifiable, so it can
  // never vouch for the chat's agent-scoped fields — two family-less ids are
  // not a match.
  const sameFamily = priorFamily !== "" && priorFamily === agentFamily(agentId);
  const keepsSession = Boolean(prior.sessionId) && sameFamily;
  const born = newChatBornDefaults(agentId);
  return {
    agentId,
    agentName: agent?.name ?? null,
    ...born,
    ...priorConfiguration(agentId, sameFamily ? prior : {}),
    sessionId: keepsSession ? (prior.sessionId ?? undefined) : undefined,
    prePlanModeId: undefined,
  };
}

/** The subset of a repaired chat's own configuration that the resolved agent
 * can still honor. Only an explicit prior model qualifies: a null model already
 * means "the global default", whose effort/Fast belong to whatever that default
 * resolves to today, not to this chat. Effort is clamped to the model's current
 * ladder and Fast to its capability, so a record written against an older
 * catalog is repaired rather than carried forward wholesale.
 *
 * The permission posture travels as ONE unit with its exact native id: taking
 * the coarse posture alone would pair it with the born default's `lastModeId`
 * and describe a mode the chat never ran. */
function priorConfiguration(
  agentId: string,
  prior: PriorChatIdentity,
): Partial<AutoBindChatSettings> {
  const model = prior.model?.trim();
  if (!model) return {};
  if (!modelsForAgent(agentId, null).some((option) => option.value === model)) {
    return {};
  }
  return {
    model,
    ...(prior.effort
      ? { effort: effectiveEffort(agentId, model, prior.effort) }
      : {}),
    fast: prior.fast === true && agentSupportsFast(agentId, model),
    ...(prior.permissionMode && prior.lastModeId
      ? { permissionMode: prior.permissionMode, lastModeId: prior.lastModeId }
      : {}),
  };
}

// ── Provisional bindings awaiting the authoritative registry ──
//
// A chat bound before the registry answered holds a GUESS. The reconcile pass
// in chat-view re-resolves it from the live list, and it needs the identity the
// chat had BEFORE that guess: passing the guess itself back as `prior` would
// make `priorFamily` outrank the global default and pin the guess forever.

const MAX_PROVISIONAL_BINDINGS = 32;
const provisionalBindings = new Map<string, PriorChatIdentity>();

export function rememberProvisionalBinding(
  chatId: string,
  prior: PriorChatIdentity,
): void {
  if (!chatId) return;
  provisionalBindings.delete(chatId);
  provisionalBindings.set(chatId, prior);
  // Bounded like every other retained renderer map: a long session that churns
  // through chats drops its oldest un-reconciled guess instead of growing.
  while (provisionalBindings.size > MAX_PROVISIONAL_BINDINGS) {
    const oldest = provisionalBindings.keys().next();
    if (oldest.done) break;
    provisionalBindings.delete(oldest.value);
  }
}

/** One-shot read: the pre-guess identity, removed so a chat is reconciled at
 * most once. Null when this chat's binding was already authoritative. */
export function takeProvisionalBinding(
  chatId: string,
): PriorChatIdentity | null {
  const prior = provisionalBindings.get(chatId);
  if (prior === undefined) return null;
  provisionalBindings.delete(chatId);
  return prior;
}

/** Test seam — the map outlives any single component by design. */
export function clearProvisionalBindings(): void {
  provisionalBindings.clear();
}
