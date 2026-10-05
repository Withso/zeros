import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

export type ListRowProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

/** Compact tool disclosure/hover row. Disclosure state and keyboard behavior
 * belong to the caller; this primitive adds no state or event handlers.
 * Legacy transition-colors in className is `@deprecated`: preserves a
 * pre-existing recipe; unify during the UI iteration. New callers use the
 * row's default motion. */
const ListRow = React.forwardRef<HTMLButtonElement, ListRowProps>(
  ({ type = "button", className, ...props }, ref) => (
    <button
      {...props}
      ref={ref}
      type={type}
      className={cn(
        "hover:bg-bg2-hover/40 -ml-2 flex w-fit max-w-full items-center gap-2 rounded-md px-2 py-1 text-left",
        className,
      )}
    />
  ),
);
ListRow.displayName = "ListRow";

export { ListRow };
