import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";
import { layoutClasses, type LayoutProps } from "./layout-props";

/** Vertical layout on the design scale. className is for outer layout
 * (width, shrink, positioning), not gap, alignment, or visual styling. */
const Stack = React.forwardRef<HTMLElement, LayoutProps>(
  ({ as = "div", gap, align, justify, wrap, className, ...props }, ref) =>
    React.createElement(as, {
      ...props,
      ref,
      className: cn(
        "flex flex-col",
        layoutClasses({ gap, align, justify, wrap }),
        className,
      ),
    }),
);
Stack.displayName = "Stack";

export { Stack };
