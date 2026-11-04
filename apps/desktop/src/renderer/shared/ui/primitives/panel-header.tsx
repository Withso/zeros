import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";
import { IconButtonSizeContext } from "./icon-button";

export interface PanelHeaderProps extends React.HTMLAttributes<HTMLElement> {
  as?: "div" | "section" | "header";
  size: "window" | "panel";
}

const HEADER_CLASSES = {
  window:
    "border-border1 bg-bg1 flex h-10 shrink-0 items-center gap-1 border-b px-2",
  panel: "border-border1 flex h-9 items-center gap-2 border-b px-3",
} as const;

/** Window chrome (40px) and panel headings (36px) share their own geometry.
 * Icon buttons inside default to 28px; group them in PanelHeaderActions.
 * Legacy geometry overrides in className (window h-9 or gap-2) are
 * `@deprecated`: preserves a pre-existing recipe; unify during the UI iteration. */
const PanelHeader = React.forwardRef<HTMLElement, PanelHeaderProps>(
  ({ as = "div", size, className, ...props }, ref) => (
    <IconButtonSizeContext.Provider value="standard">
      {React.createElement(as, {
        ...props,
        ref,
        className: cn(HEADER_CLASSES[size], className),
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
