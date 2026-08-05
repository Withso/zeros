import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

/** Elevated, compact tool group used for direct manipulation surfaces. */
const Toolbar = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, role = "toolbar", ...props }, ref) => (
  <div
    ref={ref}
    role={role}
    className={cn(
      "border-border2 bg-bg2 text-fg1 inline-flex items-center gap-1 rounded-lg border p-1 shadow-[var(--shadow-xl)]",
      className,
    )}
    {...props}
  />
));
Toolbar.displayName = "Toolbar";

export { Toolbar };
