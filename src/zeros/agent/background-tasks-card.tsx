// BackgroundTasksCard
//
// Claude may park its foreground turn while a provider-native task continues.
// This card is intentionally limited to that quiet continuation window: while
// foreground events stream the transcript already communicates activity, and
// once the active set is empty the turn can settle normally.

import { memo, useState } from "react";
import { ChevronDown, Play, Square } from "lucide-react";

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
import { agentFamily } from "./model-catalog";

export function shouldShowBackgroundTasksCard(options: {
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
