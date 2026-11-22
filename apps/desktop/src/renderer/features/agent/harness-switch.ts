// In-place agent/model switch: the chat keeps its id while the composer's
// staged pick replaces the active agent or model.

import type { AgentToolMessage } from "./use-agent-session";
import type { TranscriptMode } from "./transcript-format";
import { agentFamily, displayNameForModelValue } from "./model-catalog";

export const HARNESS_SWITCH_TOOL_KIND = "harness_switch";

export interface AgentModelPick {
  agentId: string;
  agentName?: string | null;
  model: string | null;
}

/** The transcript the next harness is seeded with: the conversation and
 * reasoning without tool noise. */
export function harnessSwitchTranscriptMode(): TranscriptMode {
  return "handoff";
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

/** Closing a session drops its unsent queue, so a harness change waits for it. */
export function harnessSwitchBlockedByQueue(
  harnessChanged: boolean,
  queuedCount: number,
): boolean {
  return harnessChanged && queuedCount > 0;
}

/** Wire-text prefix that hands the previous harness's conversation to the new
 *  one inside the user's next prompt. The bubble shows only what the user typed. */
export function handoffContextPrefix(input: { fromLabel: string; text: string; complete?: boolean }): string {
  const omitted = input.complete === false
    ? "\n\nEarlier messages were omitted because the conversation exceeded the transcript read limit."
    : "";
  return `${HANDOFF_CONTEXT_OPEN} from="${input.fromLabel.replace(/"/g, "'")}">
This chat was handed over from another agent. The transcript below is the earlier conversation, for context only; it is not a new request. Answer the user message that follows it.

${input.text.trimEnd()}${omitted}
</context_handoff>

User message:
`;
}

export const HANDOFF_CONTEXT_OPEN = "<context_handoff";

export type HarnessSwitchCommit = "switched" | "stale" | "unsupported";

/** Moves the chat to the picked harness. A cloud worker rejects a settings
 * upsert while the chat still belongs to the old agent, so its own switch
 * (which also stops the turn and saves the row) runs first. `unsupported`
 * means a pinned older worker; nothing has changed yet. */
export async function commitHarnessSwitch(steps: {
  cloud: boolean;
  switchCloudAgent: () => Promise<HarnessSwitchCommit>;
  recordRow: () => Promise<void>;
  closeSession: () => Promise<unknown> | null | undefined | void;
  stillCurrent: () => boolean;
  updateSettings: () => void;
}): Promise<HarnessSwitchCommit> {
  if (steps.cloud) {
    const outcome = await steps.switchCloudAgent();
    if (outcome !== "switched") return outcome;
  }
  await steps.recordRow();
  await Promise.resolve(steps.closeSession()).catch(() => false);
  if (!steps.stillCurrent()) return "stale";
  steps.updateSettings();
  return "switched";
}

/** What a composer send does with a staged pick. A pick never interrupts the
 *  running turn: a harness change waits for it unless the user steers. */
export function stagedPickOnSend(state: {
  harnessChanged: boolean;
  hasDraft: boolean;
  queuedCount: number;
  running: boolean;
  behavior: "queue" | "steer";
}): "none" | "model" | "blocked" | "hold" | "restart" | "switch" {
  if (!state.hasDraft) return "none";
  if (!state.harnessChanged) return "model";
  if (harnessSwitchBlockedByQueue(true, state.queuedCount)) return "blocked";
  if (!state.running) return "switch";
  return state.behavior === "steer" ? "restart" : "hold";
}
