import type { SVGProps } from "react";

import type { WorkspaceStatus } from "@/renderer/platform/git";
import { cn } from "@/renderer/shared/ui/cn";
import { statusMeta } from "@/renderer/shared/lib/workspace-status";

// Lifecycle glyphs on a 16×16 grid: a 1.5px ring plus a
// center-filled "pie" whose arc length encodes progress. Backlog is a dashed
// ring; done/cancelled swap the pie for a check / ✕. All drawn in currentColor
// so the wrapper's `text-status-*` class sets the hue.

const RING = {
  cx: 8,
  cy: 8,
  r: 6,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
} as const;

const PIE_R = 3;
const PIE_CIRCUMFERENCE = 2 * Math.PI * PIE_R;

/** A center-out pie wedge: an r=3 circle stroked at width 6 (so it fills a solid
 *  disc up to r=6), revealed to `fraction` of full via strokeDasharray and
 *  started at 12 o'clock (rotate -90). */
function Pie({ fraction }: { fraction: number }) {
  return (
    <circle
      cx={8}
      cy={8}
      r={PIE_R}
      fill="none"
      stroke="currentColor"
      strokeWidth={6}
      strokeDasharray={`${PIE_CIRCUMFERENCE * fraction} ${PIE_CIRCUMFERENCE}`}
      transform="rotate(-90 8 8)"
    />
  );
}

export interface StatusIconProps extends SVGProps<SVGSVGElement> {
  status: WorkspaceStatus;
}

/** Renders the lifecycle glyph for a workspace status. Self-coloring via the
 *  status token; pass a `text-*` className to override (e.g. a muted variant). */
export function StatusIcon({ status, className, ...props }: StatusIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn("size-4 shrink-0", statusMeta(status).colorClass, className)}
      {...props}
    >
      {status === "backlog" && (
        <circle {...RING} strokeDasharray="1.8 2.2" strokeLinecap="round" />
      )}
      {status === "in-progress" && (
        <>
          <circle {...RING} />
          <Pie fraction={0.4} />
        </>
      )}
      {status === "in-review" && (
        <>
          <circle {...RING} />
          <Pie fraction={0.72} />
        </>
      )}
      {status === "done" && (
        <>
          <circle {...RING} />
          <path
            d="M5.4 8.2l1.7 1.8 3.5-3.9"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {status === "cancelled" && (
        <>
          <circle {...RING} />
          <path
            d="M6 6l4 4M10 6l-4 4"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}
