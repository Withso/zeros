import React from "react";
import { cn } from "../cn";

/** Determinate usage/progress bar. Omitted values render an unavailable track,
 * never an indeterminate loading animation or a misleading zero-percent bar. */
export function ProgressBar({
  value,
  className,
  ...props
}: Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
  value?: number;
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
      className={cn("bg-bg2 h-1.5 overflow-hidden rounded-full", className)}
    >
      {percent !== undefined && (
        <div
          className="bg-green-fg h-full rounded-full"
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}
