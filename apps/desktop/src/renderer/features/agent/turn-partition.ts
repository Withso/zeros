import { toolPresentationReady } from "./renderers/tool-readiness";
// Split working narration/tools from provider-declared final answers.
// Live events retain their source order and become inspectable immediately.

import type { AgentMessage, AgentToolMessage } from "./use-agent-session";

export interface TurnPartition {
  /** Tools, thinking, in-between narration, sub-agents — the reasoning
   *  feed shown dimmed (and collapsible once the turn settles). */
  working: AgentMessage[];
  /** The trailing agent/system text and standalone output records, rendered
   *  brightly. Empty when the turn ended with working content only. */
  finalOutput: AgentMessage[];
}

export interface PartitionOptions {
  /** Live phase-less text remains working narration until the turn settles. */
  live?: boolean;
}

/** Replaced legacy fragments retain their durable ids with empty text so a
 * database upsert can retire them. They contribute neither rows nor counts. */
export function isVisibleTranscriptEvent(event: AgentMessage): boolean {
  if (event.kind === "tool") return toolPresentationReady(event);
  return (
    event.kind !== "text" ||
    (event.role !== "agent" && event.role !== "thought") ||
    event.text !== "" ||
    event.redacted === true
  );
}

/** A USER-INITIATED compaction row (Compact now / typed /compact →
 *  rawInput.trigger "manual", stamped by the adapters). It renders
 *  STANDALONE — a visible agent-output row, never folded into the working
 *  group's summary chip. AUTO compactions (the agent compacting itself mid-turn,
 *  trigger "auto"/absent) stay in the working group like any tool call. */
export function isManualCompaction(e: AgentMessage): boolean {
  if (e.kind !== "tool") return false;
  const t = e as AgentToolMessage;
  if (t.toolKind !== "compaction") return false;
  const input = t.rawInput;
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { trigger?: unknown }).trigger === "manual"
  );
}

function isOutputText(e: AgentMessage): boolean {
  if (e.kind !== "text") return false;
  const text = e as { role?: string; phase?: string };
  const role = text.role;
  // Reasoning ("thought") is working content, never the answer.
  // Codex commentary is also working narration even when it immediately
  // precedes a final answer. Phase-less text keeps legacy behavior for
  // Claude, Cursor, and older persisted Codex turns.
  return role === "system" || (role === "agent" && text.phase !== "commentary");
}

/** The "Turn stopped · BUDGET" record. It names the turn's ending,
 *  so it must sit visibly ABOVE the footer (it replaces a footer status
 *  pill), never folded into the working group's summary chip. It's emitted
 *  at result time, after the concluding answer, so trailing-run membership
 *  keeps it standalone. (The "Model switched" record is the opposite by
 *  design: it stays inline in the working group where the swap happened.) */
function isBudgetStop(e: AgentMessage): boolean {
  if (e.kind !== "tool") return false;
  return (e as AgentToolMessage).toolKind === "budget_stop";
}

/** A background task can settle after its parent turn's answer. It remains a
 * tool call and therefore belongs in the collapsible working stripe, but its
 * late arrival must be transparent to answer-boundary detection: otherwise a
 * settled lifecycle row after the reply would make the real answer disappear.
 * The parent can be idle while a task still runs. Its activity signal, rather
 * than the child task's status, determines whether the answer is settled. */
function isBackgroundTask(e: AgentMessage): boolean {
  if (e.kind === "error_notice" && !e.parentToolId && e.code?.startsWith("claude-background-")) return true;
  if (e.kind !== "tool") return false;
  const tool = e as AgentToolMessage;
  return tool.toolKind === "background_task";
}

/** Trailing-run membership: the concluding answer text, plus any manual
 *  compaction row (which typically lands AFTER the answer — the user
 *  compacted an idle chat — and must stay visible, not fold into the
 *  chip). */
function isFinalOutputEvent(e: AgentMessage): boolean {
  return isOutputText(e) || isManualCompaction(e) || isBudgetStop(e);
}

export function partitionTurn(
  events: AgentMessage[],
  options?: PartitionOptions,
): TurnPartition {
  events = events.filter(isVisibleTranscriptEvent);
  const finalOutputIndexes = new Set<number>();
  events.forEach((event, index) => {
    if (
      event.kind === "text" &&
      event.role === "agent" &&
      event.phase === "final_answer"
    ) {
      finalOutputIndexes.add(index);
    }
  });
  // Legacy providers have no phase. Keep their settled trailing-answer
  // convention, while an explicit final phase survives any late bookkeeping.
  for (let i = events.length - 1; !options?.live && i >= 0; i--) {
    if (isBackgroundTask(events[i])) continue;
    if (isFinalOutputEvent(events[i])) {
      finalOutputIndexes.add(i);
    } else {
      break;
    }
  }
  if (finalOutputIndexes.size === 0) {
    return { working: events.slice(), finalOutput: [] };
  }
  const working: AgentMessage[] = [];
  const finalOutput: AgentMessage[] = [];
  events.forEach((event, index) => {
    (finalOutputIndexes.has(index) ? finalOutput : working).push(event);
  });
  return { working, finalOutput };
}

export interface TurnSegment {
  kind: "working" | "output";
  /** First durable event id keeps disclosure state stable as a feed grows. */
  key: string;
  events: AgentMessage[];
}

/** A send can produce several confirmed replies, separated by more work.
 * Keep those boundaries in source order instead of moving later work ahead
 * of an earlier answer. The legacy partition remains available to counters. */
export function partitionTurnSequence(events: AgentMessage[], options?: PartitionOptions): TurnSegment[] {
  const { working, finalOutput } = partitionTurn(events, options);
  const output = new Set(finalOutput);
  const visible = new Set([...working, ...finalOutput]);
  const segments: TurnSegment[] = [];
  for (const event of events) {
    if (!visible.has(event)) continue;
    const kind = output.has(event) ? "output" : "working";
    const previous = segments.at(-1);
    if (kind === "working" && previous?.kind === kind) previous.events.push(event);
    else segments.push({ kind, key: event.id, events: [event] });
  }
  return segments;
}
