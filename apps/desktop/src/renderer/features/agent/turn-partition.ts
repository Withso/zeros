import { toolPresentationReady, withoutRedundantAgentTasks } from "./renderers/tool-readiness";
import { isTurnFailureNotice } from "./turn-failure";
import { isProviderWorkEvent, isUsageNotice, usageStatusChanges } from "./transcript-notices";
// Split working narration/tools from provider-declared partial/final answers.
// Live events retain their source order and become inspectable immediately.

import type { AgentMessage, AgentToolMessage } from "./use-agent-session";

export interface TurnPartition {
  /** Tools, thinking, in-between narration, sub-agents — the reasoning
   *  feed shown dimmed (and collapsible once the turn settles). */
  working: AgentMessage[];
  /** Confirmed partial/final answers, legacy trailing text and standalone
   * output records, rendered brightly without changing turn lifetime. */
  finalOutput: AgentMessage[];
}

export interface PartitionOptions {
  /** Live phase-less text remains working narration until the turn settles. */
  live?: boolean;
  /** This provider turn has a footer that owns its settled terminal failures.
   * Omit for child feeds, standalone records and transcript export. */
  failureTurnId?: string;
  /** Provider-turn events that include this segment's own. A Claude usage
   * notice stays in the working feed where it arrived, but only where it
   * changes that turn's status. Defaults to the segment's own events. */
  usageEvents?: readonly AgentMessage[];
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
  if (e.kind !== "text" || e.wakeupNotice) return false;
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
  if (e.kind === "text" && e.localNote) return true;
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
  const { working, finalOutput } = partitionVisible(events, options);
  return { working, finalOutput };
}

/** The split plus the visible events it was made from, in source order. A
 * usage status row can be a projection of its native record. */
function partitionVisible(
  events: AgentMessage[],
  options?: PartitionOptions,
): TurnPartition & { events: AgentMessage[] } {
  events = withoutRedundantAgentTasks(events).filter(isVisibleTranscriptEvent);
  // The cloud hook can precede native activity. Keep the settled answer and
  // waiting line intact until work actually starts; do not create an empty
  // status-only chip at the idle tail. Full activity export keeps the record.
  if (options?.live === false) {
    while (events.length > 0) {
      const last = events.at(-1)!;
      if (last.kind !== "text" || !last.wakeupNotice) break;
      events.pop();
    }
  }
  // Usage is inbetween status, like other runtime feedback: later work follows
  // it in the working feed. A repeated receipt adds no row.
  if (events.some(isUsageNotice)) {
    const usage = usageStatusChanges(options?.usageEvents ?? events);
    events = events.flatMap((event) => {
      if (!isUsageNotice(event)) return [event];
      const row = usage.get(event.id);
      return row ? [row] : [];
    });
  }
  const finalOutputIndexes = new Set<number>();
  const failureTurnId = options?.failureTurnId;
  let liveFailureIndex = -1;
  events.forEach((event, index) => {
    if (isProviderWorkEvent(event)) liveFailureIndex = -1;
    if (options?.live && failureTurnId && isTurnFailureNotice(event, failureTurnId)) {
      liveFailureIndex = index;
    }
    if (
      event.kind === "text" &&
      event.role === "agent" &&
      !event.wakeupNotice &&
      (event.phase === "final_answer" || event.phase === "partial_answer")
    ) {
      finalOutputIndexes.add(index);
    }
  });
  // Legacy providers have no phase. Keep their settled trailing-answer
  // convention, while explicit answers survive further work and bookkeeping.
  for (let i = events.length - 1; !options?.live && i >= 0; i--) {
    if (isBackgroundTask(events[i]) || isUsageNotice(events[i])) continue;
    if (isFinalOutputEvent(events[i])) {
      finalOutputIndexes.add(i);
    } else {
      break;
    }
  }
  const working: AgentMessage[] = [];
  const finalOutput: AgentMessage[] = [];
  events.forEach((event, index) => {
    // Keep the native event as an answer boundary above: dropping a failure
    // before partitioning would turn unfinished phase-less prose into output.
    // Before settlement, show the latest terminal notice outside activity.
    // Afterwards, the footer owns the card and its recovery actions.
    if (failureTurnId && isTurnFailureNotice(event, failureTurnId)) {
      if (index === liveFailureIndex) finalOutput.push(event);
      return;
    }
    (finalOutputIndexes.has(index) ? finalOutput : working).push(event);
  });
  return { events, working, finalOutput };
}

export interface TurnSegment {
  kind: "working" | "output";
  /** Durable anchor retained from the last committed group when history grows
   * at either end. New groups start with their first visible event id. */
  key: string;
  events: AgentMessage[];
}

/** A send can produce several confirmed replies, separated by more work.
 * Keep those boundaries in source order instead of moving later work ahead
 * of an earlier answer. The legacy partition remains available to counters. */
export function partitionTurnSequence(
  events: AgentMessage[],
  options?: PartitionOptions,
  previousSegments: readonly TurnSegment[] = [],
): TurnSegment[] {
  const partition = partitionVisible(events, options);
  const output = new Set(partition.finalOutput);
  const visible = new Set([...partition.working, ...partition.finalOutput]);
  const segments: TurnSegment[] = [];
  for (const event of partition.events) {
    if (!visible.has(event)) continue;
    const kind = output.has(event) ? "output" : "working";
    const previous = segments.at(-1);
    if (kind === "working" && previous?.kind === kind) previous.events.push(event);
    else segments.push({ kind, key: event.id, events: [event] });
  }
  // Prepending within a working run must not remount EventStripe or its
  // nested tool/Agent disclosures. Match durable rows only, and let at most
  // one new group inherit each prior subtree. Prefer its original anchor if
  // a newly confirmed report splits a previously paginated group.
  if (previousSegments.length > 0) {
    const workingByEventId = new Map<string, TurnSegment>();
    for (const segment of segments) {
      if (segment.kind !== "working") continue;
      for (const event of segment.events) workingByEventId.set(event.id, segment);
    }
    const claimed = new Set<TurnSegment>();
    for (const previous of previousSegments) {
      if (previous.kind !== "working") continue;
      let retained = workingByEventId.get(previous.key);
      if (!retained) {
        for (const event of previous.events) {
          retained = workingByEventId.get(event.id);
          if (retained) break;
        }
      }
      if (!retained || claimed.has(retained)) continue;
      retained.key = previous.key;
      claimed.add(retained);
    }
  }
  return segments;
}
