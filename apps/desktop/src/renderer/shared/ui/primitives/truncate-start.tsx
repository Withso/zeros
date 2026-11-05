import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

/** One line that ellipsizes at its start, so a folder path keeps its deepest
 *  folder in view ("…/auth/providers"). Only the box runs right to left, which
 *  moves the overflow to the left edge; the isolate keeps the text itself left
 *  to right, so a leading "." or a trailing "/" never jumps sides. */
export function TruncateStart({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="truncate-start"
      dir="rtl"
      className={cn("min-w-0 truncate text-left", className)}
      {...props}
    >
      <bdi dir="ltr">{children}</bdi>
    </span>
  );
}
