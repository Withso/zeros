// BackgroundTasksCard
//
// Provider-native work may outlive foreground streaming. Keep its task list
// and Stop controls visible whenever work exists; whether that work also keeps
// the foreground turn logically live is a separate provider-specific policy.

import { memo, useEffect, useState } from "react";
import { ChevronDown, Play, Square } from "lucide-react";

import { formatElapsed, ZerosSpinner } from "@/renderer/shared/ui/loading";
import { cn } from "@/renderer/shared/ui/cn";
import { Button } from "@/renderer/shared/ui/primitives/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/renderer/shared/ui/primitives/card";
import { Tooltip } from "@/renderer/shared/ui/primitives/tooltip";
import type { BackgroundTask } from "../../platform/bridge/agent-events";
import { agentFamily } from "./model-catalog";

export function shouldShowBackgroundTasksCard(options: {
  agentId: string | null;
  effort: string | null;
  foregroundStreaming: boolean;
  taskCount: number;
}): boolean {
  return options.taskCount > 0;
}

export function shouldKeepTurnLiveForBackgroundTasks(options: {
  agentId: string | null;
  effort: string | null;
  foregroundStreaming: boolean;
  taskCount: number;
}): boolean {
  const { agentId, effort, foregroundStreaming, taskCount } = options;
  return (
    agentFamily(agentId) === "claude" &&
    effort === "ultracode" &&
    !foregroundStreaming &&
    taskCount > 0
  );
}

export interface BackgroundTasksCardProps {
  tasks: BackgroundTask[];
  onStop: (taskId: string) => void;
}

export const BackgroundTasksCard = memo(function BackgroundTasksCard({
  tasks,
  onStop,
}: BackgroundTasksCardProps) {
  // Collapse is draft-like view state: it intentionally does not survive a
  // remount, while the task snapshot itself remains session-keyed in Zustand.
  const [collapsed, setCollapsed] = useState(false);

  if (tasks.length === 0) return null;

  return (
    <Card surface="base" className="overflow-hidden">
      <CardHeader className="h-9 flex-row items-center justify-between space-y-0 p-1">
        <CardTitle className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <Play className="text-fg2 size-4 shrink-0" aria-hidden="true" />
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
        <CardContent className="border-border1 flex flex-col border-t p-1">
          {tasks.map((task) => {
            return (
              <div
                key={task.taskId}
                className="hover:bg-bg2-hover flex h-9 min-w-0 items-center gap-2 rounded-md p-1"
              >
                <span className="text-fg1 min-w-0 flex-1 truncate text-sm">
                  {task.name}
                </span>
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
    startedAt,
    active = true,
  }: {
    tasks: BackgroundTask[];
    startedAt: number;
    active?: boolean;
  }) {
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
  // Retained hidden chats stay mounted, so only advance the clock while this
  // chat surface is active.
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
