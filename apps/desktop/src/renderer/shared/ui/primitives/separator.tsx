import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";

import { cn } from "@/renderer/shared/ui/cn";

/** One rule: border1 on the canvas, border2 inside floating surfaces and
 * toolbars (`surface="floating"`). */
const Separator = React.forwardRef<
  React.ComponentRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root> & {
    surface?: "canvas" | "floating";
  }
>(
  (
    { className, orientation = "horizontal", decorative = true, surface = "canvas", ...props },
    ref,
  ) => (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0",
        surface === "floating" ? "bg-border2" : "bg-border1",
        orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
        className,
      )}
      {...props}
    />
  ),
);
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
