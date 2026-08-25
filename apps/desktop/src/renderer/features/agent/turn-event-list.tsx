// ──────────────────────────────────────────────────────────
// TurnEventList — render a turn as a working group + answer
// ──────────────────────────────────────────────────────────
//
// 2026-06-18. A turn splits into two parts (see turn-partition.ts):
//
//   • the WORKING group — tools, thinking, in-between narration,
//     sub-agents — handed to one EventStripe. While live, its visible
//     projection contains only completed/failed tools and immutable records;
//     prose, reasoning, and unfinished calls stay unmounted. Once the turn
//     settles, the full work history collapses to a single summary chip
//     ("<N> tool calls, <M> messages, <K> agents"). Browser actions are nested
//     inside that same group and reappear when it is expanded.
//
//   • the FINAL OUTPUT — the trailing agent text — mounted brightly below the
//     group only after the terminal turn boundary.
//
// The shape is deliberate: completed actions arrive one by one, then the work
// folds away and the complete answer appears at once.
// ──────────────────────────────────────────────────────────

import { memo, useMemo, type ReactNode } from "react";

import { ActivityShimmer } from "@/renderer/shared/ui/loading";
import { pickStartedAt } from "./activity-hud";
import { EventStripe } from "./renderers/event-stripe";
import { MessageView } from "./renderers";
import type { RendererContext } from "./renderers";
import type { AgentMessage } from "./use-agent-session";
import type { WorkflowProgress } from "../../platform/bridge/agent-events";
import { partitionTurn } from "./turn-partition";
import { tailIndicators } from "./tail-indicators";
import { WorkflowActivity } from "./workflow-activity";

interface TurnEventListProps {
  events: AgentMessage[];
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
  /** Newest foreground workflow for this exact session. It renders only at
   * the live visual tail, directly above the ordinary agent shimmer. */
  workflow?: WorkflowProgress | null;
  onStopWorkflow?: (taskId: string) => void;
  /** The turn footer (run time, copy, "…", file pills). Rendered INSIDE this
   *  component's 768 lane so it hugs the answer and the pills align under it —
   *  as a TurnContainer sibling it picked up the container's gap-4 (a ~20px gap
   *  the user flagged). Null/absent for turns with no footer. */
  footer?: ReactNode;
  ctx: RendererContext;
}

export const TurnEventList = memo(function TurnEventList({
  events,
  isActive,
  isStreaming,
  showActivity = true,
  activityEvents,
  activityStartedAt,
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

  // Pass `live` so partitionTurn withholds provisional prose and unfinished
  // calls. The terminal boundary switches directly from the append-only tool
  // completion feed to collapsed history + the complete final output.
  const { working, finalOutput } = useMemo(
    () => partitionTurn(events, { live }),
    [events, live],
  );

  // The tail shimmer + TIMER always runs while the turn is live, including
  // while an unfinished tool/subagent row is intentionally withheld. It is the
  // single stable working cue between completed rows and carries the one elapsed
  // timer for the turn.
  //
  // The shimmer and the workflow row answer different questions and so have
  // different gates — see tail-indicators.ts for why they must not be folded
  // together. `pickActiveWorkflow` already restricts `workflow` to
  // running/paused runs, so nothing settled can linger in this row.
  const awaitingUserInput =
    ctx.pendingQuestionToolCallIds.size > 0 || !!ctx.pendingPermission;
  const tail = tailIndicators({ live, showActivity, awaitingUserInput });
  const showShimmer = tail.shimmer;
  const workflowRow =
    tail.workflow && workflow && onStopWorkflow
      ? { workflow, onStop: onStopWorkflow }
      : null;

  // 2026-06-18: the agent's output + tool calls render in a LEFT-aligned lane
  // capped at max-w-[768px] (`w-full max-w-[768px] self-start`) — the reading
  // measure for the answer + tool feed. This cap is NARROWER than the
  // conversation envelope: the band (agent-chat.tsx `.zeros-agent-messages`)
  // and the composer are max-w-[1152px], but each turn's content reads at a
  // comfortable 768. `self-start` left-anchors the lane to the band's left edge
  // (which lines up with the composer's left edge); the user prompt is its
  // right-anchored counterpart (turn-container.tsx: `items-end` +
  // `max-w-[768px]`) — the answer hugs the LEFT, the prompt hugs the RIGHT,
  // both capped at 768 inside the wide 1152 band. RESPONSIVE: the cap is
  // ABSOLUTE, so `w-full` fills the band whenever it is narrower than 768 (a
  // shrunk conversation pane → content fits the window) and only caps once it would exceed
  // 768. A proportional cap (max-w-[80%]) was tried and reverted — it reserved
  // a fixed % gutter at *every* width, so content never filled a narrow window
  // ("only [cap] when it hits the width, not every time"). `min-w-0` keeps the
  // per-row `truncate` (event-row.tsx) working so long tool commands/paths
  // single-line-ellipsize to the lane width instead of wrapping; nested
  // sub-agent rows inherit a tighter measure from their indented body and so
  // truncate harder.
  // Render nothing when the turn has no events yet AND isn't streaming, so an
  // empty wrapper doesn't render.
  if (
    working.length === 0 &&
    finalOutput.length === 0 &&
    !showShimmer &&
    !workflowRow &&
    !footer
  ) {
    return null;
  }

  return (
    <div className="flex w-full max-w-[768px] min-w-0 flex-col self-start">
      {working.length > 0 && (
        <EventStripe
          events={working}
          ctx={ctx}
          live={live}
          browserTailClosed={finalOutput.length > 0}
        />
      )}
      {finalOutput.map((event) => (
        <MessageView key={event.id} message={event} ctx={ctx} />
      ))}
      {workflowRow ? <WorkflowActivity {...workflowRow} /> : null}
      {/* Shimmer + live timer at the tail of the active turn while streaming.
          pickStartedAt anchors it to the turn's own start, so it counts
          monotonically for the whole turn; per-tool elapsed belongs to each
          tool row's own DurationChip, not to this one. */}
      {showShimmer && (
        <ActivityShimmer
          startedAt={pickStartedAt(activityEvents ?? events, activityStartedAt)}
        />
      )}
      {/* Per-turn footer, in-lane so it hugs the answer (see prop doc). */}
      {footer}
    </div>
  );
});
