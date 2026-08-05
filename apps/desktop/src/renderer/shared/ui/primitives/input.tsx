import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

const Input = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<"input">
>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        // Default 32px tall (h-8 — the control-height ceiling), 6px radius, border3
        // on transparent. Focus = a `highlighted-bright` border, NO ring. Consumers
        // may set a SHORTER height for compact spots, but 32px is the max.
        "flex h-8 w-full rounded-sm border border-border3 bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-fg1 placeholder:text-fg2 focus-visible:outline-none focus-visible:border-highlighted-bright disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
