import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

const SURFACE = {
  page: "bg-bg2",
  // Cards fill with bg1-bright, which is bg2 in Light: step up to stay visible.
  card: "bg-bg2-highlight",
} as const;

/** A quiet placeholder bar for content that is still loading: 8px tall,
 * `bg2` (`bg2-highlight` on a card), 4px corners, no shimmer. Give it a
 * width; screen readers skip it, so the surrounding region carries
 * `aria-busy` or a label. */
export function SkeletonLine({
  className,
  style,
  surface = "page",
}: {
  className?: string;
  style?: React.CSSProperties;
  surface?: keyof typeof SURFACE;
}) {
  return (
    <span
      aria-hidden
      data-slot="skeleton"
      className={cn(SURFACE[surface], "block h-2 shrink-0 rounded-sm", className)}
      style={style}
    />
  );
}
