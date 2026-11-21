// In-place agent/model switch: the chat keeps its id while the composer's
// staged pick replaces the active agent or model.

import type { AgentToolMessage } from "./use-agent-session";
import type { TranscriptMode } from "./transcript-format";
import { agentFamily, displayNameForModelValue } from "./model-catalog";

export const HARNESS_SWITCH_TOOL_KIND = "harness_switch";

/** Appended to the seeded transcript when a running turn was stopped for the
 * switch, so the new agent resumes the work instead of summarizing it. */
export const HARNESS_SWITCH_CONTINUE_NOTE =
  "The previous agent was stopped mid-turn by an agent switch. Continue the task from where it stopped.";

export interface AgentModelPick {
  agentId: string;
  agentName?: string | null;
  model: string | null;
}

/** The transcript the next harness is seeded with. Phase 3's "handoff" mode
 * replaces "full" here. */
export function harnessSwitchTranscriptMode(): TranscriptMode {
  return "full";
}

/** A pick that changes provider family needs a new adapter; anything else is
 * the provider's own model change. */
export function isHarnessChange(
  currentAgentId: string | null | undefined,
  nextAgentId: string,
): boolean {
  return agentFamily(currentAgentId ?? null) !== agentFamily(nextAgentId);
}

/** True when the staged pick differs from what the chat runs now. */
export function isPendingPick(
  staged: AgentModelPick | null | undefined,
  active: { agentId?: string | null; model?: string | null },
): staged is AgentModelPick {
  if (!staged) return false;
  return (
    agentFamily(staged.agentId) !== agentFamily(active.agentId ?? null) ||
    (staged.model ?? "") !== (active.model ?? "")
  );
}

export function pickLabel(pick: AgentModelPick): string {
  return (pick.model && displayNameForModelValue(pick.agentId, pick.model)) || pick.agentName || pick.agentId;
}

/** The transcript row recording a user-applied switch. */
export function buildHarnessSwitchMessage(input: {
  id: string;
  from: { agentId?: string | null; model?: string | null };
  to: AgentModelPick;
  now: number;
}): AgentToolMessage {
  const harnessChanged = isHarnessChange(input.from.agentId, input.to.agentId);
  return {
    id: input.id,
    kind: "tool",
    toolCallId: input.id,
    title: `Switched to ${pickLabel(input.to)}`,
    toolKind: HARNESS_SWITCH_TOOL_KIND,
    status: "completed",
    rawInput: {
      fromAgentId: input.from.agentId ?? null,
      fromModel: input.from.model ?? null,
      toAgentId: input.to.agentId,
      toModel: input.to.model,
      harnessChanged,
    },
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function isHarnessSwitchMessage(message: { kind: string; toolKind?: string }): boolean {
  return message.kind === "tool" && message.toolKind === HARNESS_SWITCH_TOOL_KIND;
}
