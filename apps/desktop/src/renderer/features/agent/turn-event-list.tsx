// ──────────────────────────────────────────────────────────
// TurnEventList — render a turn as a working group + answer
// ──────────────────────────────────────────────────────────
//
// 2026-06-18. A turn splits into two parts (see turn-partition.ts):
//
//   • the WORKING group — tools, thinking, in-between narration,
//     sub-agents — handed to one EventStripe in source order. Live narration,
//     readable reasoning, and running calls remain visible. Once the turn
//     settles, the work history collapses to a single summary chip
//     ("<N> tool calls, <M> messages, <K> agents"). Browser actions are nested
//     inside that same group and reappear when it is expanded.
//
//   • the FINAL OUTPUT — provider-declared final answers, or the settled
//     trailing text of providers without phases — rendered brightly below it.
// ──────────────────────────────────────────────────────────

import { memo, useMemo, type ReactNode } from "react";

import { ActivityShimmer } from "@/renderer/shared/ui/loading";
import { useExperimentalFeature } from "../settings/experimental-features";
import { pickStartedAt } from "./activity-hud";
import { EventStripe } from "./renderers/event-stripe";
import { MessageView } from "./renderers";
import type { RendererContext } from "./renderers";
import type { AgentMessage } from "./use-agent-session";
import type { BackgroundTask, WorkflowProgress } from "../../platform/bridge/agent-events";
import { BackgroundTasksWaitingLine } from "./background-task-activity";
import { useTurnSequence } from "./use-turn-sequence";
import { tailIndicators } from "./tail-indicators";
import { WorkflowActivity } from "./workflow-activity";

interface TurnEventListProps {
  events: AgentMessage[];
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
}: TurnEventListProps) {
  // "Live" = this is the active turn AND the session is still streaming, i.e.
  // the agent is working right now. The working group stays expanded while
  // live; the instant the turn settles it collapses into one chip and the
  // final answer (finalOutput) is what remains bright.
  const live = isActive && !!isStreaming;

  // Phase-less prose stays in the working feed while live. Explicit final
  // answers keep their output position even if bookkeeping arrives later.
  const sequence = useTurnSequence(events, live, ctx.chatId, failureTurnId);
  const tailId = sequence.at(-1)?.events.at(-1)?.id ?? null;
  const turnCtx = useMemo(() => ({ ...ctx, isStreaming: live, lastMessageId: tailId }), [ctx, live, tailId]);

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

  // The agent's output + tool calls render in a LEFT-aligned lane capped at
  // max-w-[800px] (`w-full max-w-[800px] self-start`) — the reading measure
  // for the answer + tool feed. 2026-09-27: it matches the conversation's
  // 800px content column (agent-chat.tsx `.zeros-agent-messages` and the
  // composer are max-w-[856px] with 28px gutters), so prose and the composer
  // share one column. `self-start` left-anchors the lane to the band's left
  // edge (which lines up with the composer's left edge); the user prompt is
  // its right-anchored counterpart (turn-container.tsx: `items-end` +
  // `max-w-[min(800px,100%)]`) — the answer hugs the LEFT, the prompt hugs the
  // RIGHT. RESPONSIVE: the cap is ABSOLUTE, so `w-full` fills the band
  // whenever it is narrower than 800 (a shrunk conversation pane → content
  // fits the window) and only caps once it would exceed 800. A proportional
  // cap (max-w-[80%]) was tried and reverted — it reserved
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
    <div className="flex w-full max-w-[800px] min-w-0 flex-col self-start">
      {sequence.map((segment, index) => segment.kind === "working" ? (
        <EventStripe key={JSON.stringify([ctx.chatId, segment.kind, segment.key])} events={segment.events} ctx={turnCtx} live={live}
          browserTailClosed={index < sequence.length - 1} />
      ) : (
        <MessageView key={JSON.stringify([ctx.chatId, segment.kind, segment.key])} message={segment.events[0]} ctx={turnCtx} />
      ))}
      {workflowRow ? <WorkflowActivity {...workflowRow} /> : null}
      {/* Shimmer + live timer at the tail of the active turn while streaming.
          pickStartedAt anchors it to the turn's own start, so it counts
          monotonically for the whole turn; per-tool elapsed belongs to each
          tool row's own DurationChip, not to this one. Under earlier rows it
          sits a little lower, so it reads as the turn's rail, not one more
          row. */}
      {showShimmer && (
        <ActivityShimmer
          startedAt={pickStartedAt(activityEvents ?? events, activityStartedAt)}
          className={sequence.length > 0 || workflowRow ? "mt-2" : undefined}
          gibberish={gibberish}
        />
      )}
      {/* Per-turn footer, in-lane so it hugs the answer (see prop doc). */}
      {footer}
      {showBackgroundWaiting && (
        <BackgroundTasksWaitingLine
          tasks={backgroundTasks!}
          startedAt={pickStartedAt(activityEvents ?? events, activityStartedAt)}
          active={surfaceActive}
        />
      )}
    </div>
  );
});
