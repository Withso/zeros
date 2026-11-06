import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";
import { IconButtonSizeContext } from "./icon-button";

export interface PanelHeaderProps extends React.HTMLAttributes<HTMLElement> {
  as?: "div" | "section" | "header";
  size: "window" | "panel";
  /** The bottom border1 rule. Off where the row's own fill and the row below
   * already separate them (the workspace header above the chat strips). */
  divider?: boolean;
}

const HEADER_CLASSES = {
  window: "bg-bg1 flex h-10 shrink-0 items-center gap-1 pr-1.5 pl-3",
  panel: "flex h-9 items-center gap-2 pr-1 pl-3",
} as const;
const HEADER_DIVIDER_CLS = "border-border1 border-b";

/** Window chrome (40px) and panel headings (36px) share their own geometry:
 * text starts 12px in, and a trailing 28px icon button ends as far from the
 * edge as from the top (6px in a window, 4px in a panel). Icon buttons inside
 * default to 28px; group them in PanelHeaderActions.
 * Legacy geometry overrides in className (window h-9 or gap-2) are
 * `@deprecated`: preserves a pre-existing recipe; unify during the UI iteration. */
const PanelHeader = React.forwardRef<HTMLElement, PanelHeaderProps>(
  ({ as = "div", size, divider = true, className, ...props }, ref) => (
    <IconButtonSizeContext.Provider value="standard">
      {React.createElement(as, {
        ...props,
        ref,
        className: cn(HEADER_CLASSES[size], divider && HEADER_DIVIDER_CLS, className),
      })}
    </IconButtonSizeContext.Provider>
  ),
);
PanelHeader.displayName = "PanelHeader";

/** The heading: 13 medium fg1 that truncates. */
function PanelHeaderTitle({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("text-fg1 min-w-0 flex-1 truncate text-xs leading-4.5 font-medium", className)}
      {...props}
    />
  );
}

/** Trailing actions, 2px apart at both sizes. */
function PanelHeaderActions({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ml-auto flex shrink-0 items-center gap-0.5", className)} {...props} />;
}

export { PanelHeader, PanelHeaderActions, PanelHeaderTitle };
