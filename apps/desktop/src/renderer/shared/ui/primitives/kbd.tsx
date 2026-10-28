import * as React from "react";
import { ArrowBigUp, ArrowDown, ArrowDownRight, ArrowLeft, ArrowRight, ArrowUp, ArrowUpLeft, ChevronUp, Command, CornerDownLeft, Option } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";

/**
 * Kbd — the canonical keyboard-shortcut chip for dropdown / menu rows.
 *
 * One consistent style everywhere a menu row shows a shortcut (⌘T, ⌘R, ⌘1…):
 * a bordered chip in `--border1` with `--fg2` text at 11px. Right-align it in
 * a flex menu row with `className="ml-auto"`. It sits on the bg3 popover
 * surface, where `border1` reads as a subtle-but-visible outline (the design
 * rule lives in docs/design-system.md — border1 / fg2 / 11px, app-wide).
 */
const SYMBOL_KEYS = {
  "←": ArrowLeft, "→": ArrowRight, "↑": ArrowUp, "↓": ArrowDown,
  "↖": ArrowUpLeft, "↘": ArrowDownRight,
  "⌘": Command, "⌥": Option, "⇧": ArrowBigUp, "⌃": ChevronUp, "↵": CornerDownLeft,
};

function Kbd({ className, children, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="kbd"
      className={cn(
        "inline-flex shrink-0 select-none items-center gap-0.5 rounded-sm border border-border1 px-1 py-px text-2xxs font-medium tabular-nums text-fg2",
        className,
      )}
      {...props}
    >
      {typeof children === "string" ? children.split(/([⌘⌥⇧⌃↵←→↑↓↖↘])/).map((part, index) => {
        const Icon = Object.hasOwn(SYMBOL_KEYS, part) ? SYMBOL_KEYS[part as keyof typeof SYMBOL_KEYS] : null;
        return Icon ? <React.Fragment key={index}>
          <span className="sr-only">{part}</span>
          <Icon className="size-3 shrink-0" aria-hidden="true" />
        </React.Fragment> : part;
      }) : children}
    </span>
  );
}

export { Kbd };
