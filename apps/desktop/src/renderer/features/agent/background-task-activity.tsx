// Claude's quiet background continuation, below the settled turn footer.
import { memo, useEffect, useState } from "react";
import { formatElapsed, ZerosSpinner } from "@/renderer/shared/ui/loading";
import type { BackgroundTask } from "../../platform/bridge/agent-events";

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
