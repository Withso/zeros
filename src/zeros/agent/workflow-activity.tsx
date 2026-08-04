import { memo } from "react";
import { Square, Workflow } from "lucide-react";

import { cn } from "@/zeros/ui/cn";
import { Button } from "@/zeros/ui/primitives/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/zeros/ui/primitives/hover-card";
import { Tooltip } from "@/zeros/ui/primitives/tooltip";
import type {
  WorkflowPhaseProgress,
  WorkflowProgress,
} from "../bridge/agent-events";

/** Fixed density from the settled design: task volume changes the filled
 * proportion, never the number or height of the horizontal cells. */
export const WORKFLOW_SEGMENT_COUNT = 32;

export function filledWorkflowSegments(
  completed: number,
  total: number,
): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, completed / total));
  return Math.max(
    0,
    Math.min(WORKFLOW_SEGMENT_COUNT, Math.round(ratio * WORKFLOW_SEGMENT_COUNT)),
  );
}

export function workflowPhaseCountLabel(
  phase: Pick<WorkflowPhaseProgress, "completed" | "total">,
): string {
  return phase.total > 0 ? `${phase.completed}/${phase.total}` : "Queued";
}

/** A workflow can settle mid-turn: the engine keeps the snapshot until the
 * turn's result boundary so the hover panel's final counts stay readable. The
 * row must then stop claiming the run is live — hardcoding "Workflow running"
 * left a finished workflow labelled as running (with a live Stop) until the
 * agent's whole turn ended. */
export function workflowStatusLabel(
  status: WorkflowProgress["status"],
): string {
  switch (status) {
    case "paused":
      return "Workflow paused";
    case "completed":
      return "Workflow complete";
    case "failed":
      return "Workflow failed";
    case "killed":
      return "Workflow stopped";
    default:
      return "Workflow running";
  }
}

/** Stop only means something while the run can still be stopped. */
export function workflowIsStoppable(
  status: WorkflowProgress["status"],
): boolean {
  return status === "running" || status === "paused";
}

/** The newest workflow that still speaks for work in flight, or null.
 *
 * The engine keeps a settled snapshot in the session until the turn's result
 * boundary so its final counts stay readable, so "newest by updatedAt" alone
 * would leave a completed/failed run sitting above the shimmer as "Workflow
 * running", with a live Stop, for the remainder of the turn. */
export function pickActiveWorkflow(
  workflows: readonly WorkflowProgress[],
): WorkflowProgress | null {
  let latest: WorkflowProgress | null = null;
  for (const workflow of workflows) {
    if (!workflowIsStoppable(workflow.status)) continue;
    if (
      !latest ||
      workflow.updatedAt > latest.updatedAt ||
      (workflow.updatedAt === latest.updatedAt &&
        workflow.startedAt > latest.startedAt)
    ) {
      latest = workflow;
    }
  }
  return latest;
}

interface WorkflowActivityProps {
  workflow: WorkflowProgress;
  onStop: (taskId: string) => void;
}

/** The compact row follows the exact current tool-row icon/name tier. Its
 * details are available only on hover in a current-token bg1 surface. */
export const WorkflowActivity = memo(function WorkflowActivity({
  workflow,
  onStop,
}: WorkflowActivityProps) {
  const label = workflowStatusLabel(workflow.status);
  return (
    <HoverCard openDelay={150} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="group/workflow-row -ml-2 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-bg2-hover/40"
          aria-label={`${label}: ${workflow.name}`}
        >
          <Workflow className="text-fg2 size-3 shrink-0" aria-hidden="true" />
          <span className="text-fg1 truncate text-sm">{label}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="border-border2 bg-bg1 w-[min(520px,calc(100vw-24px))] overflow-hidden p-0"
      >
        <WorkflowProgressPanel workflow={workflow} onStop={onStop} />
      </HoverCardContent>
    </HoverCard>
  );
});

/** The hover surface itself — header (title + actions) over the phase rows.
 * Split out from the trigger so it can be rendered and asserted directly. */
export const WorkflowProgressPanel = memo(function WorkflowProgressPanel({
  workflow,
  onStop,
}: WorkflowActivityProps) {
  const stoppable = workflowIsStoppable(workflow.status);
  return (
    <>
      <div className="border-border1 flex h-8 min-w-0 items-center gap-2 border-b px-3">
        <span className="text-fg1 min-w-0 flex-1 truncate text-sm font-medium">
          {workflow.name}
        </span>
        {/* The current Agent SDK exposes per-workflow Stop but no pause
            control. Keep the settled action position visible and honest;
            enable it when the provider adds a scoped pause method. */}
        <Tooltip label="Pause is not available in the current Agent SDK">
          <span className="inline-flex">
            <Button type="button" size="sm" variant="ghost" disabled>
              Pause
            </Button>
          </span>
        </Tooltip>
        <Tooltip
          label={
            stoppable ? "Stop workflow" : workflowStatusLabel(workflow.status)
          }
        >
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={!stoppable}
            aria-label={`Stop ${workflow.name}`}
            onClick={() => onStop(workflow.taskId)}
          >
            <Square className="size-3" aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      <div className="flex max-h-[min(360px,calc(100vh-96px))] flex-col overflow-y-auto px-3 py-2">
        {workflow.phases.map((phase) => (
          <WorkflowPhaseRow
            key={`${phase.index}:${phase.title}`}
            phase={phase}
            workflowComplete={workflow.status === "completed"}
          />
        ))}
      </div>
    </>
  );
});

const WorkflowPhaseRow = memo(function WorkflowPhaseRow({
  phase,
  workflowComplete,
}: {
  phase: WorkflowPhaseProgress;
  workflowComplete: boolean;
}) {
  const filled = filledWorkflowSegments(phase.completed, phase.total);
  const complete = workflowComplete || phase.status === "completed";
  return (
    <div className="grid min-h-8 min-w-0 grid-cols-[minmax(72px,auto)_minmax(0,1fr)_auto] items-center gap-2">
      <span className="text-fg1 max-w-28 truncate text-xs">{phase.title}</span>
      <div
        className="flex h-2 min-w-0 gap-[2px]"
        role="progressbar"
        aria-label={`${phase.title} progress`}
        aria-valuemin={0}
        aria-valuemax={phase.total}
        aria-valuenow={phase.completed}
      >
        {Array.from({ length: WORKFLOW_SEGMENT_COUNT }, (_, index) => (
          <span
            key={index}
            // rounded-sm is what the settled design specifies for these cells
            // (.workflow-segment → var(--radius-sm) in the design artifact).
            // The radius scale is a fixed 3 steps on purpose (zeros-tokens.css),
            // so a hand-written rounded-[2px] was both off-scale and off-design.
            className={cn(
              "h-2 min-w-0 flex-1 rounded-sm",
              complete
                ? "bg-green-primary"
                : index < filled
                  ? "bg-fg2"
                  : "bg-bg4",
            )}
          />
        ))}
      </div>
      <span className="text-fg3 min-w-12 text-right text-xs tabular-nums">
        {workflowPhaseCountLabel(phase)}
      </span>
    </div>
  );
});
