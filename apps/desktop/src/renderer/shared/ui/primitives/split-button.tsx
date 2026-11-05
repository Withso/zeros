import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import { ZerosSpinner } from "@/renderer/shared/ui/loading/zeros-spinner";
import { DropdownMenu, DropdownMenuTrigger } from "./dropdown-menu";

// Two bordered halves with no clipping shell, so each half draws Button's own
// outer focus ring. The halves overlap by their 1px border; the hovered, open
// or focused half rises above its neighbour so its whole border shows.
const HALF =
  "relative inline-flex items-center justify-center border border-transparent whitespace-nowrap text-xs leading-4.5 font-medium outline-none transition-colors duration-120 ease-out focus-visible:z-2 focus-visible:border-highlighted-bright focus-visible:ring-[3px] focus-visible:ring-highlighted-bright/50 disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress [&_svg]:pointer-events-none [&_svg]:shrink-0";

const SIZE = {
  default: {
    action: "py-1 [&_svg:not([class*='size-'])]:size-3.5",
    chevron: "p-1 [&_svg]:size-3.5",
  },
  compact: {
    action: "py-0.5 [&_svg:not([class*='size-'])]:size-3",
    chevron: "px-1 py-0.5 [&_svg]:size-3",
  },
} as const;

const VARIANT = {
  secondary: {
    action:
      "border-border3 text-fg1 enabled:hover:z-1 enabled:hover:border-border4 enabled:hover:bg-bg2-highlight",
    chevron:
      "-ml-px border-border3 text-muted-fg enabled:hover:z-1 enabled:hover:border-border4 enabled:hover:bg-bg2-highlight enabled:hover:text-fg2 data-[state=open]:z-1 data-[state=open]:border-border4 data-[state=open]:bg-bg2-highlight data-[state=open]:text-fg2",
  },
  // The divider is the label colour at 15% over the half's own fill, so it
  // follows the fill on hover and open.
  primary: {
    action:
      "border-r-0 border-primary-button-bg bg-primary-button-bg text-primary-button-fg enabled:hover:border-primary-button-hover enabled:hover:bg-primary-button-hover focus-visible:-mr-px focus-visible:border-r",
    chevron:
      "border-primary-button-bg border-l-primary-button-fg/15 bg-primary-button-bg text-primary-button-fg enabled:hover:border-primary-button-hover enabled:hover:border-l-primary-button-fg/15 enabled:hover:bg-primary-button-hover data-[state=open]:border-primary-button-hover data-[state=open]:border-l-primary-button-fg/15 data-[state=open]:bg-primary-button-hover focus-visible:border-l-highlighted-bright",
  },
  // Merge when it can run: the PR status green, with the primary variant's
  // divider. A merge that can't run is the secondary outline.
  merge: {
    action:
      "border-r-0 border-green-primary bg-green-primary text-[var(--pr-status-merge-fg)] enabled:hover:opacity-90 focus-visible:-mr-px focus-visible:border-r",
    chevron:
      "border-green-primary border-l-[color-mix(in_srgb,var(--pr-status-merge-fg)_20%,transparent)] bg-green-primary text-[var(--pr-status-merge-fg)] enabled:hover:opacity-90 data-[state=open]:opacity-90 focus-visible:border-l-highlighted-bright",
  },
} as const;

export type SplitButtonVariant = keyof typeof VARIANT;
export type SplitButtonSize = keyof typeof SIZE;

/** Class names for a split button's shell and halves, for callers that need
 * their own segment markup (a Tooltip around the action, a busy state). */
export function splitButtonClasses(
  variant: SplitButtonVariant = "secondary",
  size: SplitButtonSize = "default",
) {
  return {
    shell: "inline-flex w-fit shrink-0 items-stretch",
    action: cn(
      HALF,
      "min-w-0 flex-1 gap-1 rounded-l-md px-1.5 [&>[data-zeros-loader]+svg]:hidden",
      SIZE[size].action,
      VARIANT[variant].action,
    ),
    chevron: cn(HALF, "rounded-r-md", SIZE[size].chevron, VARIANT[variant].chevron),
  };
}

export interface SplitButtonProps {
  /** The action's label (and optional leading icon). */
  children: React.ReactNode;
  onClick: () => void;
  /** Accessible name of the menu segment. */
  menuLabel: string;
  /** A `DropdownMenuContent` with the related choices. */
  menu: React.ReactNode;
  variant?: SplitButtonVariant;
  size?: SplitButtonSize;
  disabled?: boolean;
  /** Defaults to `disabled`. */
  menuDisabled?: boolean;
  /** Busy: the spinner takes the action icon's place and the menu waits. */
  loading?: boolean;
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
  size = "default",
  disabled = false,
  menuDisabled = disabled,
  loading = false,
  open,
  onOpenChange,
  className,
}: SplitButtonProps) {
  const classes = splitButtonClasses(variant, size);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <div data-slot="split-button" className={cn(classes.shell, className)}>
        <button
          type="button"
          className={classes.action}
          disabled={disabled || loading}
          aria-busy={loading || undefined}
          onClick={onClick}
        >
          {loading ? (
            <ZerosSpinner
              size={size === "compact" ? 16 : 18}
              tone={variant === "primary" ? "inverted" : variant === "merge" ? "inherit" : "default"}
              label="Working"
            />
          ) : null}
          {children}
        </button>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={classes.chevron}
            disabled={menuDisabled || loading}
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
