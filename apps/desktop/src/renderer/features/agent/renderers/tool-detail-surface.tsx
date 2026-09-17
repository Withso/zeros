import type { ReactNode } from "react";
import { cn } from "@/renderer/shared/ui/cn";

/** One scroll owner for the entire expanded operation, including errors and
 * diffs. Content renderers must not add their own cards or vertical scrollers. */
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
        "border-border2 bg-bg2 text-fg1 focus-visible:ring-highlighted-bright max-h-[320px] min-w-0 overflow-auto overscroll-contain rounded-md border text-sm focus-visible:ring-1 focus-visible:outline-none",
        failed &&
          // Shiki uses inline token colors; failure styling must override them.
          "border-red-primary/25 bg-red-bg text-red-primary [&_*]:text-red-primary!",
      )}
    >
      {children}
    </div>
  );
}
