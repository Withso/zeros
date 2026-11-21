// Pure rules for a working run: whether it is a collapsible group, the span
// its header reports, and what the live turn's loader line shows.

import type { AgentMessage, AgentToolMessage } from "./use-agent-session";
import { isInBetweenMessage, isVisibleTranscriptEvent, type TurnSegment } from "./turn-partition";
import { fallbackProse } from "./model-fallback";
import { countEventSummary } from "./renderers/tool-summary";
import { isTransientConnectionNotice, isUsageNotice } from "./transcript-notices";
import { metaForEvent } from "./renderers/event-meta";

/** The entries a working feed renders: visible events, with old model-switch
 * records shown as their fallback prose. */
export function workingFeedEvents(events: AgentMessage[]): AgentMessage[] {
  return events.filter(isVisibleTranscriptEvent).map((message) =>
    message.kind === "tool" && message.toolKind === "model_switch"
      ? fallbackProse(message) ?? message
      : message,
  );
}

/** Tool calls in a run, sub-agents included. */
export function workingToolCalls(events: AgentMessage[]): number {
  const counts = countEventSummary(events);
  return counts.toolCalls + counts.agents;
}

/** A visible thinking row, redacted ones included. */
function isThought(event: AgentMessage): boolean {
  return event.kind === "text" && event.role === "thought" && isVisibleTranscriptEvent(event);
}

/** Work rows in a run: tool calls, sub-agents and visible thinking rows. */
export function workingRows(events: AgentMessage[]): number {
  return workingToolCalls(events) + events.filter(isThought).length;
}

/** Two work rows make a group. A run that folds in-between messages
 * (setting off) is a group whenever it holds one, even with no work row
 * (commentary followed directly by the answer): its header shows the time
 * and no icons. A lone call stays a plain row. */
export function isWorkingGroup(events: AgentMessage[]): boolean {
  return workingRows(events) >= 2 || events.some(isInBetweenMessage);
}

function endTime(event: AgentMessage): number {
  // A tool's first terminal time does not move when late output lands.
  if (event.kind === "tool") return event.settledAt ?? event.updatedAt ?? event.createdAt;
  if (event.kind === "text") return event.updatedAt ?? event.createdAt;
  return event.createdAt;
}

/** The run's own span from persisted times. A page that starts inside a run
 * covers only the loaded events. */
export function workingGroupSpan(events: AgentMessage[]): { startedAt: number; durationMs: number } | null {
  if (events.length === 0) return null;
  let startedAt = Infinity;
  let endedAt = -Infinity;
  for (const event of events) {
    startedAt = Math.min(startedAt, event.createdAt);
    endedAt = Math.max(endedAt, endTime(event));
  }
  return { startedAt, durationMs: Math.max(0, endedAt - startedAt) };
}

export type LoaderLine =
  | { kind: "hidden" }
  | { kind: "timer" }
  /** The user opened the live group, so its rows already show the call. */
  | { kind: "bare" }
  | { kind: "tool"; event: AgentToolMessage }
  /** `streaming`: the thought is the run's newest event, still growing. */
  | { kind: "thinking"; event: AgentMessage; streaming: boolean }
  | { kind: "status"; event: AgentMessage };

function running(tool: AgentToolMessage): boolean {
  return tool.status === "pending" || tool.status === "in_progress";
}

/** What the live turn's loader line shows. `visible` is the loader's own gate
 * (live, newest segment, not awaiting the user). Only a working run at the
 * tail can put a work row (a call or a thought) on the line; anything else
 * keeps the timer. */
/** A streaming thought is shown (as one unit, name and description) once its
 * opening line has settled. */
export function streamingThoughtReady(event: AgentMessage): boolean {
  return metaForEvent(event, { streaming: true }).target !== undefined;
}

export function loaderLineSubject({ visible, tail, groupOpen, thoughtReady = streamingThoughtReady }: {
  visible: boolean;
  tail: TurnSegment | undefined;
  groupOpen: boolean;
  /** Whether the run's still-streaming thought may show yet (a Local thought
   * streams without re-rendering the chat, so the caller reads it live). */
  thoughtReady?: (event: AgentMessage) => boolean;
}): LoaderLine {
  if (!visible) return { kind: "hidden" };
  if (tail?.kind !== "working") return { kind: "timer" };
  const events = workingFeedEvents(tail.events);
  const latest = events.at(-1);
  // Until a streaming thought's description has settled, the line keeps what
  // it showed before (the previous call, or the timer); a call that starts
  // meanwhile wins as usual.
  const rows = events.filter((event) => event.kind === "tool" ||
    (isThought(event) && (event !== latest || thoughtReady(event))));
  if (rows.length === 0 || !latest) return { kind: "timer" };
  const group = isWorkingGroup(events);
  if (group && groupOpen) return { kind: "bare" };
  // A collapsed group hides its rows, so the line also reports a transient
  // notice that arrived after the last work row. A headerless run already
  // shows it as a row.
  if (group && (isTransientConnectionNotice(latest) || isUsageNotice(latest))) return { kind: "status", event: latest };
  // A thought is still streaming while it is the run's newest event.
  const active = rows.filter((row) => row.kind === "tool" ? running(row) : row === latest);
  const event = active.length
    ? active.reduce((newest, row) => (row.createdAt >= newest.createdAt ? row : newest))
    : rows.at(-1)!;
  return event.kind === "tool" ? { kind: "tool", event } : { kind: "thinking", event, streaming: event === latest };
}

/** What the line shows once it has nothing current to name: a tail message
 * held for long (the agent is plainly writing; also under a group the reader
 * opened, whose rows do not say so), or a newer call that has waited a while
 * for its description. Then the line returns to its timer instead of naming
 * a call that finished (or a thought that ended before the newer call); a
 * call still running keeps its label. */
export function settledLoaderLine(named: LoaderLine, { heldLong, pendingCall }: {
  heldLong: boolean;
  pendingCall: { since: number; long: boolean } | null;
}): LoaderLine {
  if (named.kind === "hidden") return named;
  if (heldLong) return { kind: "timer" };
  if (!pendingCall?.long) return named;
  const superseded = named.kind === "tool" ? !running(named.event)
    : named.kind === "thinking" && named.event.createdAt <= pendingCall.since;
  return superseded ? { kind: "timer" } : named;
}

/** The loader line's lone call that just became a row in the feed (its run
 * closed without becoming a group): the row takes the line's place, so the
 * label stays put and the line re-enters below. Undefined otherwise. */
export function handedOffCall(previousLone: string | undefined, lone: string | undefined, sequence: TurnSegment[]): string | undefined {
  if (!previousLone || previousLone === lone) return undefined;
  const run = sequence.find((segment) => segment.kind === "working" && segment.events.some((event) => event.id === previousLone));
  return run && !isWorkingGroup(workingFeedEvents(run.events)) ? previousLone : undefined;
}

/** Whether anything is drawn above the loader line: a lone call that lives
 * on the line itself is not, so the line does not shift when it arrives. */
export function rowsAboveLoader(sequence: TurnSegment[], lone: string | undefined): boolean {
  return sequence.some((segment, index) => segment.kind !== "working" ||
    workingFeedEvents(segment.events).some((event) => index !== sequence.length - 1 || event.id !== lone));
}

/** Rows awaiting the user (a permission, a blocking question or a plan
 * review) stay visible under a collapsed group header. */
export function gatedEventIds(
  events: AgentMessage[],
  pendingPermissionToolCallId: string | undefined,
  pendingQuestionToolCallIds: ReadonlySet<string>,
): Set<string> {
  const gated = new Set<string>();
  for (const event of events) {
    if (event.kind !== "tool") continue;
    // A permission references the vendor's tool-use id, which is the row's
    // nativeToolCallId for Claude; match both, like the question record.
    const ids = [event.toolCallId, event.nativeToolCallId].filter((id): id is string => !!id);
    if (ids.some((id) => id === pendingPermissionToolCallId || pendingQuestionToolCallIds.has(id))) gated.add(event.id);
  }
  return gated;
}
