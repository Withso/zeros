import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";
import { FIELD_BOX, FIELD_FOCUS, FIELD_INVALID } from "./field";

const APPEARANCE = {
  /** The Input field box over several lines: at least three lines (68px). It
   *  grows with its text, like the bare one, up to 240px, then scrolls; there
   *  is no drag handle. A caller may set its own max height. */
  field: cn(
    "flex min-h-17 max-h-60 w-full min-w-0 resize-none overflow-y-auto field-sizing-content px-2 py-1.5 placeholder:text-fg3",
    FIELD_BOX,
    FIELD_FOCUS,
    FIELD_INVALID,
  ),
  /** No box, for a field whose surface is the box, as the composer is. It
   *  grows with its text from one line; the caller caps it with a max height,
   *  past which it scrolls. Keyboard focus draws a 1px accent ring. */
  bare:
    "block w-full min-w-0 resize-none rounded-sm border-0 bg-transparent p-0 text-reading text-fg1 outline-none field-sizing-content placeholder:text-fg3 overflow-y-auto overscroll-contain disabled:cursor-not-allowed disabled:opacity-50 focus-visible:data-[zeros-keyboard-focus]:ring-1 focus-visible:data-[zeros-keyboard-focus]:ring-accent",
} as const;

export interface TextareaProps extends React.ComponentProps<"textarea"> {
  appearance?: keyof typeof APPEARANCE;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, appearance = "field", ...props }, ref) => (
    <textarea
      data-appearance={appearance === "field" ? undefined : appearance}
      className={cn(APPEARANCE[appearance], className)}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Textarea };
