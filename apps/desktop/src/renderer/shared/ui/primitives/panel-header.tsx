import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

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
 * New callers use the size's recipe unchanged.
 * Legacy geometry overrides in className (window h-9 or gap-2) are
 * `@deprecated`: preserves a pre-existing recipe; unify during the UI iteration. */
const PanelHeader = React.forwardRef<HTMLElement, PanelHeaderProps>(
  ({ as = "div", size, className, ...props }, ref) =>
    React.createElement(as, {
      ...props,
      ref,
      className: cn(HEADER_CLASSES[size], className),
    }),
);
PanelHeader.displayName = "PanelHeader";

export { PanelHeader };
