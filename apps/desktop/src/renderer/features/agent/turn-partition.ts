// ──────────────────────────────────────────────────────────
// turn-partition — split a turn into "working" vs "final output"
// ──────────────────────────────────────────────────────────
//
// The live turn is an append-only completion feed: terminal tool calls appear
// as they finish, while provisional prose/reasoning stays unmounted. Once the
// engine publishes the terminal boundary, the complete answer appears in one
// render and the historical work folds into one summary chip.
//
// `partitionTurn` owns both projections:
//   - finalOutput = the trailing run of agent/system TEXT messages
//     (the concluding answer) plus the few records that explicitly render
//     beside it. Walk from the end; stop at the first working event.
//   - working     = every other event — tools, thinking, in-between agent
//     narration, sub-agents, and late background-task lifecycle records.
//
// Thinking (role:"thought") is NOT output — it's reasoning — so it
// stays in settled working history and never becomes the final answer.
//
// LIVE turns have NO concluded answer yet. Trailing text may still be followed
// by another tool, so rendering it early both streams an unwanted draft and
// moves the same DOM between dim working history and bright final output. With
// `live: true`, only immutable non-prose records and terminal tools render;
// tools are ordered by their completion update so concurrent work never inserts
// ahead of a row already on screen.
// ──────────────────────────────────────────────────────────

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
  /** True while the turn is still streaming. A live turn has no concluded
   *  answer yet, so `finalOutput` stays empty. `working` is the append-only
   *  projection of terminal tools and immutable records; provisional prose,
   *  reasoning, and unfinished tools remain unmounted. Defaults to false
   *  (settled turn). */
  live?: boolean;
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
 * Running background tasks are NOT transparent because their presence means
 * the turn has not reached a settled answer boundary. */
function isSettledBackgroundTask(e: AgentMessage): boolean {
  if (e.kind !== "tool") return false;
  const tool = e as AgentToolMessage;
  return (
    tool.toolKind === "background_task" &&
    (tool.status === "completed" || tool.status === "failed")
  );
}

/** Trailing-run membership: the concluding answer text, plus any manual
 *  compaction row (which typically lands AFTER the answer — the user
 *  compacted an idle chat — and must stay visible, not fold into the
 *  chip). */
function isFinalOutputEvent(e: AgentMessage): boolean {
  return isOutputText(e) || isManualCompaction(e) || isBudgetStop(e);
}

/** A live transcript is an append-only completion feed. Provisional prose is
 * withheld until the turn settles, and a tool becomes visible only after its
 * terminal update carries the final title/output/status. Immutable notices
 * remain visible immediately so errors and blocking records cannot disappear. */
function isCommittedLiveEvent(event: AgentMessage): boolean {
  if (event.kind === "tool") {
    return event.status === "completed" || event.status === "failed";
  }
  return event.kind !== "text" && event.kind !== "thinking";
}

function liveCommitTime(event: AgentMessage): number {
  const candidate =
    event.kind === "tool"
      ? (event.settledAt ?? event.updatedAt)
      : event.createdAt;
  return Number.isFinite(candidate) ? candidate : 0;
}

function committedLiveEvents(events: AgentMessage[]): AgentMessage[] {
  const committed: Array<{
    event: AgentMessage;
    sourceIndex: number;
    committedAt: number;
  }> = [];
  events.forEach((event, sourceIndex) => {
    if (!isCommittedLiveEvent(event)) return;
    committed.push({
      event,
      sourceIndex,
      committedAt: liveCommitTime(event),
    });
  });
  committed.sort(
    (a, b) => a.committedAt - b.committedAt || a.sourceIndex - b.sourceIndex,
  );
  return committed.map(({ event }) => event);
}

export function partitionTurn(
  events: AgentMessage[],
  options?: PartitionOptions,
): TurnPartition {
  // A live turn has no concluded answer. Show only immutable records and
  // terminal tools, ordered by completion so concurrent calls append instead
  // of inserting ahead of rows the user has already seen.
  if (options?.live) {
    return { working: committedLiveEvents(events), finalOutput: [] };
  }
  // Most turns have one contiguous answer suffix. Settled background-task
  // lifecycle rows are the exception: the provider can append them after the
  // answer, but they still render as tool calls in the working group. Walk
  // through those transparent rows while locating the answer, then partition
  // by membership instead of slicing at one cut.
  const finalOutputIndexes = new Set<number>();
  for (let i = events.length - 1; i >= 0; i--) {
    if (isSettledBackgroundTask(events[i])) continue;
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
