import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";
import { FIELD_BOX, FIELD_FOCUS, FIELD_INVALID } from "./field";

/** The Input field box over several lines: at least three lines (68px). */
const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(
        "flex min-h-17 w-full min-w-0 px-2 py-1.5 placeholder:text-fg3",
        FIELD_BOX,
        FIELD_FOCUS,
        FIELD_INVALID,
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Textarea };
