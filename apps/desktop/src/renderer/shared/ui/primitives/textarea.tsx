import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        // Matches Input: 6px radius, border3 on transparent, focus = highlighted-bright
        // border with NO ring. (Multi-line, so height is min-h rather than fixed.)
        "flex min-h-[60px] w-full rounded-sm border border-border3 bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-fg3 focus-visible:outline-none focus-visible:border-highlighted-bright disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
