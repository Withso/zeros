// ──────────────────────────────────────────────────────────
// TurnEventList — render a turn as a working group + answer
// ──────────────────────────────────────────────────────────
//
// A turn renders in source order (see turn-partition.ts):
//
//   • WORKING runs — tools, thinking, sub-agents — each handed to one
//     EventStripe. A run with two or more tool calls is a collapsed group
//     with its own "Working for" / "Worked for" header (working-group.ts).
//
//   • IN-BETWEEN MESSAGES — the model's prose while it works — sit between
//     the runs like answers while live, and after the turn unless Settings
//     folds them back into the runs.
//
//   • the FINAL OUTPUT — provider-declared answers, or the settled trailing
//     text of providers without phases — rendered brightly.
//
// The live tail's loader line shows the current tool call in place of its
// timer; a lone call there is not also a row.
// ──────────────────────────────────────────────────────────

import { ActingAs } from "./acting-as";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ActivityShimmer } from "@/renderer/shared/ui/loading";
import { useExperimentalFeature } from "../settings/experimental-features";
import { pickStartedAt } from "./activity-hud";
import { EventStripe } from "./renderers/event-stripe";
import { MessageView } from "./renderers";
import type { RendererContext } from "./renderers";
import type { AgentMessage, AgentTextMessage } from "./use-agent-session";
import type { BackgroundTask, WorkflowProgress } from "../../platform/bridge/agent-events";
import { BackgroundTasksWaitingLine } from "./background-task-activity";
import { useTurnSequence } from "./use-turn-sequence";
import { TurnDisclosureProvider, useTurnDisclosure } from "./turn-disclosures";
import type { TurnSegment } from "./turn-partition";
import { handedOffCall, isWorkingGroup, loaderLineSubject, rowsAboveLoader, settledLoaderLine, streamingThoughtReady, workingFeedEvents } from "./working-group";
import { LoaderLineLabel, loaderLineKey, useThoughtPreview } from "./loader-line";
import { LiveTailLine } from "./live-tail";
import { liveTailId } from "./tail-indicators";
import { PROVISIONAL_WAIT_MS, provisionalCallSince } from "./renderers/tool-readiness";
import { RevealHeldContext } from "./renderers/use-text-reveal";
import { prefersReducedMotion } from "@/renderer/shared/ui/motion/soft-motion";
import { useShowInBetweenMessages } from "../settings/in-between-messages";
import { tailIndicators } from "./tail-indicators";
import { WorkflowActivity } from "./workflow-activity";

interface TurnEventListProps {
  events: AgentMessage[];
  /** The turn ended because the agent finished it (turn-end.ts): its last
   * message may finish revealing in place. */
  endedNaturally?: boolean;
  /** Provider-turn history through this segment (`Turn.providerEvents`),
   * including every preceding steer. A Claude usage notice stays in
   * the working feed where it arrived, shown only where it changes that turn's
   * status, so its repeat after a steer adds no row. Defaults to `events`. */
  usageEvents?: AgentMessage[];
  /** The provider turn whose footer owns terminal failures, including across
   * steer segments. Omit when no turn footer is available. */
  failureTurnId?: string;
  /** True when this visual segment belongs to the provider turn currently at
   *  the transcript tail. A steered provider turn can own several segments;
   *  every one stays live/expanded until the shared turn settles. */
  isActive: boolean;
  /** Whether the session is streaming. Drives the live working group + the
   *  tail shimmer. */
  isStreaming?: boolean;
  /** Only the newest visual segment renders the one tail activity shimmer.
   *  Earlier segments of a steered provider turn remain expanded without
   *  duplicating the shimmer/timer around each steer bubble. Defaults true. */
  showActivity?: boolean;
  /** Events from the whole provider turn used only to anchor the activity
   *  timer. After a steer the newest visual segment can still be empty while
   *  a tool from the preceding segment is running. */
  activityEvents?: AgentMessage[];
  /** Provider-turn start fallback for an adopted live turn whose newest visual
   * segment has not received an event yet. */
  activityStartedAt?: number;
  /** Claude's quiet continuation belongs below the settled output/footer. */
  backgroundTasks?: BackgroundTask[];
  surfaceActive?: boolean;
  /** Newest foreground workflow for this exact session. It renders only at
   * the live visual tail, directly above the ordinary agent shimmer. */
  workflow?: WorkflowProgress | null;
  onStopWorkflow?: (taskId: string) => void;
  /** The turn footer (run time, copy, "…", file pills). Rendered INSIDE this
   *  component's 800 lane so it hugs the answer and the pills align under it —
   *  as a TurnContainer sibling it picked up the container's gap-4 (a ~20px gap
   *  the user flagged). Null/absent for turns with no footer. */
  footer?: ReactNode;
  ctx: RendererContext;
}

export const TurnEventList = memo(function TurnEventList({
  events,
  usageEvents,
  failureTurnId,
  isActive,
  isStreaming,
  showActivity = true,
  activityEvents,
  activityStartedAt,
  backgroundTasks,
  surfaceActive = true,
  workflow,
  onStopWorkflow,
  footer,
  ctx,
  endedNaturally = false,
}: TurnEventListProps) {
  // "Live" = this is the active turn AND the session is still streaming, i.e.
  // the agent is working right now. The working group stays expanded while
  // live; the instant the turn settles it collapses into one chip and the
  // final answer (finalOutput) is what remains bright.
  const live = isActive && !!isStreaming;

  // Phase-less prose stays in the working feed while live. Explicit final
  // answers keep their output position even if bookkeeping arrives later.
  // In-between messages always sit outside the runs while live.
  const showInBetween = useShowInBetweenMessages();
  const sequence = useTurnSequence(events, live, ctx.chatId, failureTurnId, usageEvents, live || showInBetween);
  const pendingCall = usePendingCall(live ? provisionalCallSince(events) : null);
  const tailId = liveTailId(events, sequence.at(-1)?.events.at(-1)?.id ?? null);
  const turnCtx = useMemo(() => ({ ...ctx, isStreaming: live, lastMessageId: tailId,
    turnEndedNaturally: !live && endedNaturally }), [ctx, live, tailId, endedNaturally]);

  // One tail shimmer and elapsed timer cover the live turn, including pauses
  // between tool events. Optional questions do not pause that activity.
  //
  // The shimmer and the workflow row answer different questions and so have
  // different gates — see tail-indicators.ts for why they must not be folded
  // together. `pickActiveWorkflow` already restricts `workflow` to
  // running/paused runs, so nothing settled can linger in this row.
  const awaitingUserInput =
    (ctx.hasBlockingQuestion ?? ctx.pendingQuestionToolCallIds.size > 0) || !!ctx.pendingPermission;
  const tail = tailIndicators({ live, showActivity, awaitingUserInput });
  const showShimmer = tail.shimmer && surfaceActive;
  const [gibberish] = useExperimentalFeature("gibberishAgentThinking");
  const showBackgroundWaiting = isActive && showActivity && !live && !awaitingUserInput && !!backgroundTasks?.length;
  const workflowRow =
    tail.workflow && workflow && onStopWorkflow
      ? { workflow, onStop: onStopWorkflow }
      : null;

  // When the turn stops (by the user, by itself, failed or interrupted) the
  // transcript is simply in its settled state: every dissolve, rise and glide
  // still running in the turn ends at once, before the next paint.
  const root = useRef<HTMLDivElement>(null);
  const wasLive = useRef(live);
  useLayoutEffect(() => {
    if (wasLive.current && !live && root.current) settleTurnMotion(root.current);
    wasLive.current = live;
  }, [live]);

  // The agent's output + tool calls render in a LEFT-aligned lane capped at
  // the chat's text column (`w-full max-w-(--chat-lane) self-start`) — the
  // reading measure for the answer + tool feed, 800px unless Settings →
  // Appearance → Chat width picks another. It matches the conversation's
  // content column (agent-chat.tsx `.zeros-agent-messages` and the composer
  // are max-w-(--chat-column), the lane plus 28px gutters), so prose and the
  // composer share one column. `self-start` left-anchors the lane to the
  // band's left edge (which lines up with the composer's left edge); the user
  // prompt's row spans the same lane (turn-container.tsx). RESPONSIVE: the cap
  // is ABSOLUTE, so `w-full` fills the band whenever it is narrower than the
  // lane (a shrunk conversation pane → content fits the window) and only caps
  // once it would exceed it. A proportional cap (max-w-[80%]) was tried and
  // reverted — it reserved
  // a fixed % gutter at *every* width, so content never filled a narrow window
  // ("only [cap] when it hits the width, not every time"). `min-w-0` keeps the
  // per-row `truncate` (event-row.tsx) working so long tool commands/paths
  // single-line-ellipsize to the lane width instead of wrapping; nested
  // sub-agent rows inherit a tighter measure from their indented body and so
  // truncate harder.
  // Render nothing when the turn has no events yet AND isn't streaming, so an
  // empty wrapper doesn't render.
  if (
    sequence.length === 0 &&
    !showShimmer &&
    !showBackgroundWaiting &&
    !workflowRow &&
    !footer
  ) {
    return null;
  }

  return (
    <TurnDisclosureProvider
      key={JSON.stringify([ctx.attachmentCwd ?? null, ctx.chatId])}
      events={events}
      subagentChildren={ctx.subagentChildren}
    >
      <div ref={root} className="relative flex w-full max-w-(--chat-lane) min-w-0 flex-col self-start">
        <TurnSequenceFeed
          pendingCall={pendingCall}
          sequence={sequence}
          ctx={turnCtx}
          live={live}
          tailLive={live && showActivity}
          loaderVisible={tail.shimmer}
          workflowRow={workflowRow ? <WorkflowActivity {...workflowRow} /> : null}
          shimmer={showShimmer ? {
            startedAt: pickStartedAt(activityEvents ?? events, activityStartedAt),
            gibberish,
          } : null}
        />
        {showShimmer && ctx.chatId && <ActingAs chatId={ctx.chatId} active={surfaceActive} />}
        {/* Per-turn footer, in-lane so it hugs the answer (see prop doc). A
            message keeps 8px below its text; a work row has none of its own,
            so the footer takes 4px more there: the feed's 8px between a
            hovered row and the badge. */}
        {footer && sequence.at(-1)?.kind === "working" && <div aria-hidden="true" className="h-1 shrink-0" />}
        {footer}
        {showBackgroundWaiting && (
          <BackgroundTasksWaitingLine
            tasks={backgroundTasks!}
            startedAt={pickStartedAt(activityEvents ?? events, activityStartedAt)}
            active={surfaceActive}
          />
        )}
      </div>
    </TurnDisclosureProvider>
  );
});

/** A live call still waiting for its description (not drawn until it is
 * known): when it started, and whether it has waited PROVISIONAL_WAIT_MS,
 * after which the loader line stops naming a call that has finished. */
function usePendingCall(since: number | null): { since: number; long: boolean } | null {
  const [, wake] = useState(0);
  const long = since !== null && Date.now() - since >= PROVISIONAL_WAIT_MS;
  useEffect(() => {
    if (since === null || long) return;
    const timer = setTimeout(() => wake((value) => value + 1), since + PROVISIONAL_WAIT_MS - Date.now() + 1);
    return () => clearTimeout(timer);
  }, [since, long]);
  return since === null ? null : { since, long };
}

/** A live tail message the feed has not heard from yet: it is held when it
 * arrives (nothing of it is shown before its first unit) unless the reveal
 * is off for it, in which case it reports otherwise in the same paint. */
function heldOnArrival(message: AgentTextMessage, ctx: RendererContext): boolean {
  return !message.modelFallback && !message.wakeupNotice && ctx.attachmentImagesActive !== false &&
    typeof document !== "undefined" && document.visibilityState !== "hidden" && !prefersReducedMotion();
}

/** Whether the tail message has been held this long: the line then returns
 * to its timer rather than keep naming a call that has finished. */
const HELD_LINE_MS = 2_000;
function useHeldTooLong(id: string | null): boolean {
  const since = useRef<{ id: string; at: number } | null>(null);
  if (id === null) since.current = null;
  else if (since.current?.id !== id) since.current = { id, at: Date.now() };
  const [, wake] = useState(0);
  const long = !!since.current && Date.now() - since.current.at >= HELD_LINE_MS;
  useEffect(() => {
    if (!since.current || long) return;
    const timer = setTimeout(() => wake((value) => value + 1), since.current.at + HELD_LINE_MS - Date.now() + 1);
    return () => clearTimeout(timer);
  }, [id, long]);
  return long;
}

/** End every animation in a settled turn. */
function settleTurnMotion(root: HTMLElement): void {
  // Script-driven motion only; CSS animations (loader art) belong to their owners.
  for (const animation of root.getAnimations({ subtree: true }))
    if (!(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition)) animation.cancel();
}

/** Inside the disclosure boundary, so the loader line can follow whether the
 * user opened the live group. */
function TurnSequenceFeed({ sequence, ctx, live, tailLive, loaderVisible, workflowRow, shimmer, pendingCall }: {
  sequence: TurnSegment[];
  ctx: RendererContext;
  live: boolean;
  /** This segment owns the live turn's tail. */
  tailLive: boolean;
  loaderVisible: boolean;
  workflowRow: ReactNode;
  shimmer: { startedAt: number; gibberish: boolean } | null;
  /** A newer call not drawn yet (its description is still streaming). */
  pendingCall: { since: number; long: boolean } | null;
}) {
  // A tail message still held (written out of sight, nothing shown yet) is
  // laid out but not presented: the tail reads as if it were not there yet,
  // so the group stays live and the line keeps its call. When the message
  // appears, everything changes in that one commit.
  const [held, setHeld] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const reportHeld = useCallback((id: string, value: boolean | null) => setHeld((previous) => {
    if (value === null) {
      if (!previous.has(id)) return previous;
      const next = new Map(previous);
      next.delete(id);
      return next;
    }
    return previous.get(id) === value ? previous : new Map(previous).set(id, value);
  }), []);
  const tailMessage = sequence.at(-1)?.kind === "output" ? sequence.at(-1)!.events[0] : undefined;
  const heldTail = live && tailMessage?.kind === "text" && tailMessage.role === "agent" && tailMessage.id === ctx.lastMessageId &&
    (held.get(tailMessage.id) ?? heldOnArrival(tailMessage, ctx));
  const shown = heldTail ? sequence.slice(0, -1) : sequence;
  const heldLong = useHeldTooLong(heldTail ? tailMessage!.id : null);
  const last = shown.at(-1);
  const [tailOpen] = useTurnDisclosure<boolean>(last?.kind === "working" ? last.key : "", "group", false);
  // The tail's still-streaming thought shows only once its description has
  // settled; a Local thought grows without re-rendering this feed, so read it
  // live (this re-renders once, when the description is known).
  const tailEvent = last?.kind === "working" ? workingFeedEvents(last.events).at(-1) : undefined;
  const streamingThought = live && tailEvent?.kind === "text" && tailEvent.role === "thought" ? tailEvent : undefined;
  const thoughtPreview = useThoughtPreview(streamingThought, true,
    streamingThought && ctx.attachmentImagesActive !== false ? ctx.liveTextSource : undefined);
  const named = loaderLineSubject({ visible: loaderVisible, tail: last, groupOpen: tailOpen,
    thoughtReady: (event) => event === streamingThought ? thoughtPreview !== undefined : streamingThoughtReady(event) });
  const subject = settledLoaderLine(named, { heldLong, pendingCall });
  // A lone work row (a call or a thought) lives on the loader line instead.
  const loneCallId = (subject.kind === "tool" || subject.kind === "thinking") && last &&
    !isWorkingGroup(workingFeedEvents(last.events))
    ? subject.event.id
    : undefined;
  // The line's lone call just became a row at the line's place (its run
  // closed): the label stays put, and the line re-enters below.
  const previousLone = useRef(loneCallId);
  const handedOff = useRef<string | undefined>(undefined);
  const handoff = handedOffCall(previousLone.current, loneCallId, shown);
  handedOff.current = handoff ?? handedOff.current;
  // The lone call joined a new group: its header takes the line's row.
  const tucked = !!previousLone.current && !loneCallId && !handoff && last?.kind === "working" &&
    isWorkingGroup(workingFeedEvents(last.events));
  useLayoutEffect(() => { previousLone.current = loneCallId; });
  const keys = sequence.map((segment) => JSON.stringify([ctx.chatId, segment.kind, segment.key]));
  // Only rows actually drawn above count: a lone call on the line is not.
  const above = !!workflowRow || rowsAboveLoader(shown, loneCallId);
  const lineShown = !!shimmer && subject.kind !== "hidden";
  return (
    <RevealHeldContext.Provider value={reportHeld}>
      {sequence.map((segment, index) => {
        const key = keys[index];
        const isLast = index === shown.length - 1;
        return segment.kind === "working" ? (
          <EventStripe key={key} events={segment.events} ctx={ctx} live={live}
            browserTailClosed={!isLast} groupKey={segment.key}
            tail={tailLive && isLast} loaderEventId={isLast ? loneCallId : undefined} />
        ) : (
          <MessageView key={key} message={segment.events[0]} ctx={ctx} />
        );
      })}
      {workflowRow}
      {/* The loader line at the tail of the active turn while streaming.
          pickStartedAt anchors its timer to the turn's own start, so it
          counts monotonically for the whole turn. Under earlier rows it sits
          a little lower, so it reads as the turn's rail, not one more row. */}
      <LiveTailLine present={lineShown} active={ctx.attachmentImagesActive !== false} growth={sequence}
        readerOwned={tailOpen && last?.kind === "working" && isWorkingGroup(workingFeedEvents(last.events))}
        reenterKey={handedOff.current} className={above ? "mt-2" : undefined}>
        {shimmer && (
          <ActivityShimmer
            startedAt={shimmer.startedAt}
            gibberish={shimmer.gibberish}
            bare={subject.kind === "bare"}
            resetKey={handedOff.current}
            tucked={tucked}
            subject={subject.kind === "tool" || subject.kind === "thinking" || subject.kind === "status"
              ? { key: loaderLineKey(subject), label: <LoaderLineLabel subject={subject}
                source={ctx.attachmentImagesActive !== false ? ctx.liveTextSource : undefined} /> }
              : null}
          />
        )}
      </LiveTailLine>
    </RevealHeldContext.Provider>
  );
}
