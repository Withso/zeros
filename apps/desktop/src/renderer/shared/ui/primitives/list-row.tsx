import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

export type ListRowProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

/** Compact tool disclosure/hover row: 28px, a bg1-hover hover (the canvas's
 * own hover token) and the keyboard ring. Expanded adds no fill; only the
 * caller's chevron turns, so a transcript with every row open stays plain.
 * Disclosure state and keyboard behavior belong to the caller; this
 * primitive adds no state or event handlers. */
const ListRow = React.forwardRef<HTMLButtonElement, ListRowProps>(
  ({ type = "button", className, ...props }, ref) => (
    <button
      {...props}
      ref={ref}
      type={type}
      className={cn(
        "hover:bg-bg1-hover focus-visible:border-highlighted-bright focus-visible:ring-highlighted-bright/50 -ml-2 flex min-h-7 w-fit max-w-full items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left transition-colors duration-120 ease-out focus-visible:ring-[3px] focus-visible:outline-none",
        className,
      )}
    />
  ),
);
ListRow.displayName = "ListRow";

export { ListRow };
