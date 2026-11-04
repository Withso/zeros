import * as React from "react";
import { ArrowBigUp, ArrowDown, ArrowDownRight, ArrowLeft, ArrowRight, ArrowUp, ArrowUpLeft, ChevronUp, Command, CornerDownLeft, Option } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";

/**
 * Kbd — the one keyboard-shortcut chip, in menus, tooltips and the command
 * palette alike: 18px tall, border2 on bg2 so it reads on a bg3 menu (border1
 * was faint there), fg2 text at 11px. Right-align it in a flex row with
 * `className="ml-auto"`. A combination is one chip per key: use KbdKeys.
 */
const SYMBOL_KEYS = {
  "←": ArrowLeft, "→": ArrowRight, "↑": ArrowUp, "↓": ArrowDown,
  "↖": ArrowUpLeft, "↘": ArrowDownRight,
  "⌘": Command, "⌥": Option, "⇧": ArrowBigUp, "⌃": ChevronUp, "↵": CornerDownLeft,
};

const SYMBOL_SPLIT = /([⌘⌥⇧⌃↵←→↑↓↖↘])/;

function Kbd({ className, children, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="kbd"
      className={cn(
        "inline-flex h-4.5 min-w-4.5 shrink-0 select-none items-center justify-center gap-0.5 whitespace-nowrap rounded-sm border border-border2 bg-bg2 px-1 text-2xxs leading-4 font-medium tabular-nums text-fg2",
        className,
      )}
      {...props}
    >
      {typeof children === "string" ? children.split(SYMBOL_SPLIT).map((part, index) => {
        const Icon = Object.hasOwn(SYMBOL_KEYS, part) ? SYMBOL_KEYS[part as keyof typeof SYMBOL_KEYS] : null;
        return Icon ? <React.Fragment key={index}>
          <span className="sr-only">{part}</span>
          <Icon className="size-3 shrink-0" aria-hidden="true" />
        </React.Fragment> : part;
      }) : children}
    </span>
  );
}

/** The keys of a combination, so each gets its own chip: "⌘⇧T" → ⌘ · ⇧ · T,
 *  "⌘\" → ⌘ · \, "F2" and "esc" stay whole. */
export function shortcutKeys(shortcut: string): string[] {
  return shortcut.split(SYMBOL_SPLIT).filter((part) => part.trim() !== "");
}

/** One chip per key of a shortcut, 2px apart. */
function KbdKeys({
  keys,
  className,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & { keys: string }) {
  return (
    <span data-slot="kbd-keys" className={cn("inline-flex shrink-0 items-center gap-0.5", className)} {...props}>
      {shortcutKeys(keys).map((key, index) => (
        <Kbd key={`${index}-${key}`}>{key}</Kbd>
      ))}
    </span>
  );
}

/** A shortcut inside a filled button (Approve ⌘⇧↵, Close anyway ⌘↵): one 16px
 *  chip tinted from the button's own text colour, so it reads on primary and
 *  destructive fills alike. It is hidden from assistive tech; put the shortcut
 *  on the button with `aria-keyshortcuts`. */
function ButtonShortcut({ keys, className }: { keys: string; className?: string }) {
  return (
    <kbd
      aria-hidden="true"
      data-slot="button-shortcut"
      className={cn(
        "ml-1 inline-flex h-4 shrink-0 items-center rounded-sm bg-current/15 px-1 font-mono text-2xxs leading-4",
        className,
      )}
    >
      {keys}
    </kbd>
  );
}

export { ButtonShortcut, Kbd, KbdKeys };
