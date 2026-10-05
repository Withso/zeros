import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";
import { layoutClasses, type LayoutProps } from "./layout-props";

/** Horizontal layout on the design scale. className is for outer layout
 * (width, shrink, positioning), not gap, alignment, or visual styling. */
const Inline = React.forwardRef<HTMLElement, LayoutProps>(
  ({ as = "div", gap, align, justify, wrap, className, ...props }, ref) =>
    React.createElement(as, {
      ...props,
      ref,
      className: cn(
        "flex",
        layoutClasses({ gap, align, justify, wrap }),
        className,
      ),
    }),
);
Inline.displayName = "Inline";

export { Inline };
