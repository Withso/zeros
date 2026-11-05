import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

/** A quiet placeholder bar for content that is still loading: 8px tall,
 * `bg2`, 4px corners, no shimmer. Give it a width; screen readers skip it,
 * so the surrounding region carries `aria-busy`. */
export function SkeletonLine({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      aria-hidden
      data-slot="skeleton"
      className={cn("bg-bg2 block h-2 shrink-0 rounded-sm", className)}
      style={style}
    />
  );
}
