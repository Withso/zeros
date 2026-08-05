// ============================================
// COMPONENT: ActivityShimmer
// PURPOSE: Show the agent-working shimmer with a live elapsed timer.
// USED IN: The active agent turn's trailing activity row.
// ============================================

// --- IMPORTS ---
import { memo } from "react";

import { cn } from "@/renderer/shared/ui/cn";

import { LiveDuration } from "./live-duration";
import { ZerosSpinner } from "./zeros-spinner";

// --- TYPES ---
export interface ActivityShimmerProps {
  /** Start time used by the ticking elapsed counter. */
  startedAt: number;
  /** Optional layout classes supplied by the activity-row owner. */
  className?: string;
}

// --- RENDER ---
/** The caller owns when this live-only indicator mounts and unmounts. */
export const ActivityShimmer = memo(function ActivityShimmer({
  startedAt,
  className,
}: ActivityShimmerProps) {
  return (
    <div
      className={cn(
        "text-fg2 flex items-center gap-2 py-1.5 text-xs",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <ZerosSpinner
        size={16}
        variant="agent"
        label="Agent working"
        className="shrink-0"
      />
      <LiveDuration startedAt={startedAt} className="text-fg2 tabular-nums" />
    </div>
  );
});
