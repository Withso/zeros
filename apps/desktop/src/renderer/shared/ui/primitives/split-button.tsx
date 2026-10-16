import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import { DropdownMenu, DropdownMenuTrigger } from "./dropdown-menu";
import { splitTriggerClassNames } from "./select";

// The primary form mirrors Button's Primary fill. Segments sit inside one
// clipped shell, so focus draws an inset ring instead of Button's outer one.
const PRIMARY_SEGMENT =
  "inline-flex items-center outline-none transition-colors enabled:hover:bg-primary-button-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-highlighted-bright disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0";

const CLASSES = {
  primary: {
    shell:
      "inline-flex w-fit shrink-0 items-stretch overflow-hidden rounded-md bg-primary-button-bg text-primary-button-fg",
    main: cn(
      PRIMARY_SEGMENT,
      "min-w-0 flex-1 justify-center gap-1 px-1.5 py-1 text-xs leading-4.5 font-medium whitespace-nowrap [&_svg:not([class*='size-'])]:size-3.5",
    ),
    chevron: cn(
      PRIMARY_SEGMENT,
      "justify-center border-l border-primary-button-fg/15 px-1.5 data-[state=open]:bg-primary-button-hover [&_svg]:size-3.5",
    ),
  },
  secondary: splitTriggerClassNames,
} as const;

export interface SplitButtonProps {
  /** The action's label (and optional leading icon). */
  children: React.ReactNode;
  onClick: () => void;
  /** Accessible name of the menu segment. */
  menuLabel: string;
  /** A `DropdownMenuContent` with the related choices. */
  menu: React.ReactNode;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  /** Defaults to `disabled`. */
  menuDisabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/** An action with a menu of related choices beside it: "Attach simulator │ ▾".
 * Primary is for a view's single main action; secondary matches the
 * dropdown trigger chrome. */
export function SplitButton({
  children,
  onClick,
  menuLabel,
  menu,
  variant = "secondary",
  disabled = false,
  menuDisabled = disabled,
  open,
  onOpenChange,
  className,
}: SplitButtonProps) {
  const classes = CLASSES[variant];
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <div data-slot="split-button" className={cn(classes.shell, className)}>
        <button type="button" className={classes.main} disabled={disabled} onClick={onClick}>
          {children}
        </button>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={classes.chevron}
            disabled={menuDisabled}
            aria-label={menuLabel}
          >
            <ChevronDown aria-hidden />
          </button>
        </DropdownMenuTrigger>
      </div>
      {menu}
    </DropdownMenu>
  );
}
