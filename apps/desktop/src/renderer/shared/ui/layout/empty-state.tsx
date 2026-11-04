import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

/** The one empty state (docs/design-system.md §0): a 32px fg3 icon over one
 *  13/18 fg2 line, centred in the space it fills, plus one action only when
 *  it creates or configures something. */
export function EmptyState({
  icon: Icon,
  children,
  action,
  className,
  ...props
}: Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
  /** A lucide glyph or any icon component that takes className. */
  icon: React.ElementType;
  /** One line. */
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center",
        className,
      )}
      {...props}
    >
      <Icon className="text-fg3 size-8" strokeWidth={1.25} aria-hidden />
      <p className="text-fg2 m-0 max-w-sm text-xs leading-4.5">{children}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
