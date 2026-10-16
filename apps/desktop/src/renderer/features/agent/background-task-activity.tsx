// Claude's quiet background continuation, below the settled turn footer.
import { memo } from "react";
import { formatElapsed, ZerosSpinner } from "@/renderer/shared/ui/loading";
import type { BackgroundTask } from "../../platform/bridge/agent-events";
import { useVisibleClock } from "../../state/use-visible-clock";

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
    if (!active || tasks.length === 0) return null;
    return (
      <div
        className="text-fg2 flex items-center gap-2 py-1.5 text-xs"
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
  const now = useVisibleClock(active);
  return (
    <span className="text-fg2 shrink-0 text-xs tabular-nums">
      {formatElapsed(Math.max(0, now - startedAt))}
    </span>
  );
});
