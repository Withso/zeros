import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";
import { isKeyGlyph, KEY_GLYPH_SPLIT, KeyGlyphIcon } from "./key-glyphs";

/**
 * Kbd — the one keyboard-shortcut chip, in menus, tooltips and the command
 * palette alike: 18px tall, border2 on bg2 so it reads on a bg3 menu (border1
 * was faint there), fg2 text at 11px. Right-align it in a flex row with
 * `className="ml-auto"`. A combination is one chip per key: use KbdKeys.
 * Modifier, return, delete and arrow symbols draw as 11px Phosphor Bold
 * glyphs (key-glyphs.tsx), one family at the letters' weight; every other
 * key stays text.
 */
const SYMBOL_SPLIT = KEY_GLYPH_SPLIT;

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
      {typeof children === "string" ? <KeyParts text={children} glyphClassName="size-2.75 shrink-0" /> : children}
    </span>
  );
}

/** A key's text with its symbols drawn as glyphs; screen readers still read
 *  the symbol itself. */
function KeyParts({ text, glyphClassName }: { text: string; glyphClassName: string }) {
  return text.split(SYMBOL_SPLIT).map((part, index) =>
    isKeyGlyph(part) ? (
      <React.Fragment key={index}>
        <span className="sr-only">{part}</span>
        <KeyGlyphIcon glyph={part} className={glyphClassName} />
      </React.Fragment>
    ) : (
      part
    ),
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
 *  destructive fills alike. Its symbols are the same Phosphor glyphs as Kbd's.
 *  It is hidden from assistive tech; put the shortcut on the button with
 *  `aria-keyshortcuts`. */
function ButtonShortcut({ keys, className }: { keys: string; className?: string }) {
  return (
    <kbd
      aria-hidden="true"
      data-slot="button-shortcut"
      className={cn(
        "ml-1 inline-flex h-4 shrink-0 items-center gap-0.5 rounded-sm bg-current/15 px-1 font-mono text-2xxs leading-4",
        className,
      )}
    >
      <KeyParts text={keys} glyphClassName="size-2.75 shrink-0" />
    </kbd>
  );
}

export { ButtonShortcut, Kbd, KbdKeys };
