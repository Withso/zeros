import React from "react";
import { cn } from "../cn";

const FILL = {
  default: "bg-fg1",
  warning: "bg-yellow-primary",
  over: "bg-red-primary",
} as const;

/** Determinate usage/progress bar: a 4px border3 track (like the Slider) with
 * an fg1 fill, yellow near a limit and red over it. Omitted values render an
 * unavailable track, never an indeterminate loading animation or a
 * misleading zero-percent bar. */
export function ProgressBar({
  value,
  tone = "default",
  className,
  ...props
}: Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
  value?: number;
  tone?: keyof typeof FILL;
}) {
  const percent =
    value === undefined ? undefined : Math.max(0, Math.min(100, value));
  return (
    <div
      {...props}
      role={percent === undefined ? undefined : "progressbar"}
      aria-valuemin={percent === undefined ? undefined : 0}
      aria-valuemax={percent === undefined ? undefined : 100}
      aria-valuenow={percent}
      className={cn("bg-border3 h-1 overflow-hidden rounded-full", className)}
    >
      {percent !== undefined && (
        <div
          className={cn("h-full rounded-full", FILL[tone])}
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}
