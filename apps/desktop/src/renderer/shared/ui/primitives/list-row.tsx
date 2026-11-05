import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

export type ListRowProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

/** Compact tool disclosure/hover row: 28px, a bg1-hover hover (the canvas's
 * own hover token) and the keyboard ring, drawn as an inset edge plus the
 * halo so focus never moves the row's content off the feed's columns. Expanded adds no fill; only the
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
        "hover:bg-bg1-hover focus-visible:inset-ring focus-visible:inset-ring-highlighted-bright focus-visible:ring-highlighted-bright/50 -ml-2 flex min-h-7 w-fit max-w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors duration-120 ease-out focus-visible:ring-[3px] focus-visible:outline-none",
        className,
      )}
    />
  ),
);
ListRow.displayName = "ListRow";

/** Turns a ListRow into the disclosure inside a ListRowGroup: just its icon
 * and name, with the group drawing the row around it. It drops the 28px
 * minimum too, so the group is 28px like a plain ListRow, not 36. */
const LIST_ROW_IN_GROUP =
  "m-0 min-h-0 min-w-0 shrink-0 rounded-none p-0 hover:bg-transparent focus-visible:inset-ring-0 focus-visible:ring-0";

const GROUP_FOCUS =
  "has-[[data-list-row-disclosure]:focus-visible]:inset-ring has-[[data-list-row-disclosure]:focus-visible]:inset-ring-highlighted-bright has-[[data-list-row-disclosure]:focus-visible]:ring-[3px] has-[[data-list-row-disclosure]:focus-visible]:ring-highlighted-bright/50";

export interface ListRowGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The row opens and closes: it then hovers, rings while its disclosure
   * has keyboard focus, and a click on its gaps calls `onToggle`. */
  interactive?: boolean;
  onToggle?: () => void;
}

/** A ListRow whose targets (file and link pills) sit beside its disclosure
 * button. It is the same 28px row with 8px sides and 6px corners, so it hovers
 * and focuses like a plain ListRow. The disclosure is a ListRow with
 * `data-list-row-disclosure` and `LIST_ROW_IN_GROUP`; a click outside any
 * link or button toggles, and the targets keep their own clicks. */
const ListRowGroup = React.forwardRef<HTMLDivElement, ListRowGroupProps>(
  ({ interactive = true, onToggle, className, onClick, ...props }, ref) => (
    <div
      {...props}
      ref={ref}
      className={cn(
        "-ml-2 flex min-h-7 w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 transition-colors duration-120 ease-out",
        interactive && "hover:bg-bg1-hover cursor-pointer",
        interactive && GROUP_FOCUS,
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !interactive) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("a, button, input, [role='button']")) return;
        onToggle?.();
      }}
    />
  ),
);
ListRowGroup.displayName = "ListRowGroup";

export { LIST_ROW_IN_GROUP, ListRow, ListRowGroup };
