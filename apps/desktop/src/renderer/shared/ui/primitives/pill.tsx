import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

export interface PillProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

/** Compact interactive chrome control. Visual treatment lives here so feature
 * callers only supply layout, content, and behavior. */
const Pill = React.forwardRef<HTMLButtonElement, PillProps>(
  ({ className, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "border-border2 text-fg2 hover:border-border3 hover:bg-bg2-hover hover:text-fg1 focus-visible:border-highlighted-bright focus-visible:ring-highlighted-bright/50 data-[state=open]:border-border3 data-[state=open]:bg-bg2-hover data-[state=open]:text-fg1 inline-flex h-7 w-fit items-center justify-center gap-2 rounded-sm border bg-transparent px-2.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  ),
);
Pill.displayName = "Pill";

export { Pill };
