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
        // Same box as the Select dropdown trigger and every Button: 28px tall
        // (h-7), 6px corners (--radius-md), border3 on transparent. Focus = a
        // `highlighted-bright` border, NO ring. Consumers may set a SHORTER
        // height for compact spots (design inspector), but 28px is the max.
        "flex h-7 w-full rounded-md border border-border3 bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-fg1 placeholder:text-fg3 focus-visible:outline-none focus-visible:border-highlighted-bright disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
