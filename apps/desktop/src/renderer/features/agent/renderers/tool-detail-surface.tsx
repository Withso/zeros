import type { ReactNode } from "react";
import { cn } from "@/renderer/shared/ui/cn";

/** One scroll owner for the entire expanded operation, including errors and
 * diffs: a bg1 card with a border1 edge and 8px corners under the row, at
 * 13px, which keeps its own look; failures stay red. Content renderers must
 * not add their own cards or vertical scrollers. */
/** The body of an expanded record inside the surface: plain 13/18 text with
 *  the surface's own 12px sides. It never draws a second card or scroller. */
export const DETAIL_BODY_CLS = "flex flex-col gap-2 px-3 py-2.5 text-xs leading-4.5 text-fg2";

export function ToolDetailSurface({
  children,
  failed = false,
  label,
}: {
  children: ReactNode;
  failed?: boolean;
  label: string;
}) {
  return (
    <div
      data-tool-detail=""
      aria-label={label}
      role="region"
      tabIndex={0}
      className={cn(
        "border-border1 bg-bg1 text-fg1 focus-visible:ring-highlighted-bright max-h-[320px] min-w-0 select-text overflow-auto overscroll-contain rounded-lg border text-xs focus-visible:ring-1 focus-visible:outline-none",
        failed &&
          // Override Shiki's inline colors, but retain link-pill identity colors.
          "border-red-primary/25 bg-red-bg text-red-primary [&_*:not([data-local-link-pill],[data-local-link-pill]_*)]:text-red-primary!",
      )}
    >
      {children}
    </div>
  );
}
