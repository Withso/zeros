// ──────────────────────────────────────────────────────────
// turn-partition — split a turn into "working" vs "final output"
// ──────────────────────────────────────────────────────────
//
// The turn shape we render: while the agent works it streams
// reasoning + tool calls + in-between narration;
// the LAST thing it says is the actual answer. We render the answer
// brightly and fold everything else into one collapsible "working"
// group (dimmed while live, a single summary chip once done).
//
// `partitionTurn` is the pure boundary detector:
//   - finalOutput = the trailing run of agent/system TEXT messages
//     (the concluding answer) plus the few records that explicitly render
//     beside it. Walk from the end; stop at the first working event.
//   - working     = every other event — tools, thinking, in-between agent
//     narration, sub-agents, and late background-task lifecycle records.
//
// Thinking (role:"thought") is NOT output — it's reasoning — so it
// always stays in the working group even when it's the last event.
//
// LIVE turns have NO concluded answer yet. While the agent is still
// streaming, trailing text is provisional: the agent may emit more
// tools next, which would turn that "answer" back into in-between
// narration. Committing to the boundary early renders the tail text
// OUTSIDE the working feed (separated by the list's `gap-4`, carrying
// its own `py-2`), so its gap is far larger than the flat in-feed
// rhythm — and snaps tight the moment the next event lands. Pass
// `live: true` to defer the boundary entirely (everything is working);
// the answer separates out only once the turn settles.
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
   *  answer yet, so the boundary is deferred: everything stays in `working`
   *  and `finalOutput` is empty. This keeps the trailing narration in the
   *  working feed (uniform spacing) instead of lurching out and back as the
   *  tail flips between text and tool. Defaults to false (settled turn). */
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
  const role = (e as { role?: string }).role;
  // Reasoning ("thought") is working content, never the answer.
  return role === "agent" || role === "system";
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

/** Adapter notices can land after the provider's final answer while the
 * session is settling (for example MCP shutdown/cancellation notices). They
 * remain inspectable working records, but must be transparent while locating
 * the answer suffix. Otherwise a restored transcript whose last persisted row
 * is a notice folds the actual answer into the collapsed working stripe. */
function isLateWorkingNotice(e: AgentMessage): boolean {
  return e.kind === "error_notice";
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
  // A live turn hasn't concluded its answer yet — keep it all working.
  // (A manual compaction can't be live-working content: it only happens
  // idle or queues to run post-turn, so no special case here.)
  if (options?.live) return { working: events, finalOutput: [] };
  // Most turns have one contiguous answer suffix. Settled background-task
  // lifecycle rows are the exception: the provider can append them after the
  // answer, but they still render as tool calls in the working group. Walk
  // through those transparent rows while locating the answer, then partition
  // by membership instead of slicing at one cut.
  const finalOutputIndexes = new Set<number>();
  for (let i = events.length - 1; i >= 0; i--) {
    if (isSettledBackgroundTask(events[i]) || isLateWorkingNotice(events[i]))
      continue;
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
