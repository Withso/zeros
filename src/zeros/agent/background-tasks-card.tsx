// BackgroundTasksCard + BackgroundTasksWaitingLine
//
// One provider-neutral live surface for Claude shells/watchers/helpers/
// workflows/wake-ups and Codex background terminals. The deliberately quiet
// shape follows the consolidated design: title + chevron; each row has only
// its name, elapsed time, and Stop. Provider/type/status chrome stays out of
// the compact card and remains available in the settled transcript record.

import { memo, useEffect, useState } from "react";
import { Activity, ChevronDown, Square } from "lucide-react";

import { formatElapsed, ZerosSpinner } from "@/loaders";
import { cn } from "@/zeros/ui/cn";
import { Button } from "@/zeros/ui/primitives/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/zeros/ui/primitives/card";
import { Tooltip } from "@/zeros/ui/primitives/tooltip";
import type { BackgroundTask } from "../bridge/agent-events";

export interface BackgroundTasksCardProps {
  tasks: BackgroundTask[];
  onStop: (taskId: string) => void;
  /** Retained hidden chats stay mounted; suspend their clocks until visible. */
  active?: boolean;
}

export const BackgroundTasksCard = memo(function BackgroundTasksCard({
  tasks,
  onStop,
  active = true,
}: BackgroundTasksCardProps) {
  // Collapse is draft-like view state: it intentionally does not survive a
  // remount, while the task snapshot itself remains session-keyed in Zustand.
  const [collapsed, setCollapsed] = useState(false);

  if (tasks.length === 0) return null;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-center justify-between space-y-0 px-3.5 py-2.5">
        <CardTitle className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <Activity className="text-fg2 size-4 shrink-0" aria-hidden="true" />
          <span>Background Task</span>
        </CardTitle>
        <Tooltip
          label={
            collapsed ? "Expand background tasks" : "Collapse background tasks"
          }
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={
              collapsed
                ? "Expand background tasks"
                : "Collapse background tasks"
            }
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            <ChevronDown
              className={cn(
                "size-4 transition-transform",
                collapsed && "-rotate-90",
              )}
              aria-hidden="true"
            />
          </Button>
        </Tooltip>
      </CardHeader>
      {!collapsed ? (
        <CardContent className="border-border1 flex flex-col border-t p-1.5">
          {tasks.map((task) => {
            return (
              <div
                key={task.taskId}
                className="hover:bg-bg2-hover flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
              >
                <span className="text-fg1 min-w-0 flex-1 truncate text-sm">
                  {task.name}
                </span>
                <BackgroundTaskElapsed
                  startedAt={task.startedAt}
                  active={active}
                />
                <Tooltip label="Stop task">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Stop ${task.name}`}
                    onClick={() => onStop(task.taskId)}
                  >
                    <Square className="size-3" aria-hidden="true" />
                  </Button>
                </Tooltip>
              </div>
            );
          })}
        </CardContent>
      ) : null}
    </Card>
  );
});

export const BackgroundTasksWaitingLine = memo(
  function BackgroundTasksWaitingLine({
    tasks,
    active = true,
  }: {
    tasks: BackgroundTask[];
    active?: boolean;
  }) {
    // This timer measures how long the parent has been parked, not how long
    // the oldest child has been running (a task can run for minutes before
    // Claude decides it must wait for it).
    const [startedAt] = useState(() => Date.now());
    if (tasks.length === 0) return null;
    return (
      <div
        className="text-fg2 flex min-h-8 items-center gap-2 px-1 text-sm"
        role="status"
        aria-live="polite"
      >
        <ZerosSpinner
          size={16}
          label="Waiting for background tasks"
          className="shrink-0"
        />
        <span>
          Waiting for {tasks.length} background task
          {tasks.length === 1 ? "" : "s"}
        </span>
        <span aria-hidden="true">·</span>
        <BackgroundTaskElapsed startedAt={startedAt} active={active} />
      </div>
    );
  },
);

const BackgroundTaskElapsed = memo(function BackgroundTaskElapsed({
  startedAt,
  active,
}: {
  startedAt: number;
  active: boolean;
}) {
  // A one-second cadence is enough for elapsed time and avoids coupling the
  // whole chat surface to a high-frequency clock.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const intervalId = window.setInterval(
      () => setTick((value) => value + 1),
      1_000,
    );
    return () => window.clearInterval(intervalId);
  }, [active]);
  void tick;
  return (
    <span className="text-fg2 shrink-0 text-xs tabular-nums">
      {formatElapsed(Math.max(0, Date.now() - startedAt))}
    </span>
  );
});
