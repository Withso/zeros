import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

/**
 * Kbd — the canonical keyboard-shortcut chip for dropdown / menu rows.
 *
 * One consistent style everywhere a menu row shows a shortcut (⌘T, ⌘R, ⌘1…):
 * a bordered chip in `--border1` with `--fg2` text at 11px. Right-align it in
 * a flex menu row with `className="ml-auto"`. It sits on the bg3 popover
 * surface, where `border1` reads as a subtle-but-visible outline (the design
 * rule lives in zeros-foundation.md §4 — border1 / fg2 / 11px, app-wide).
 */
function Kbd({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="kbd"
      className={cn(
        "inline-flex shrink-0 select-none items-center rounded-sm border border-border1 px-1 py-px text-2xxs font-medium tabular-nums text-fg2",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
