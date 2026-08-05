// ──────────────────────────────────────────────────────────
// ShortcutsPalette — the ⌘/ glass shortcuts menu
// ──────────────────────────────────────────────────────────
//
// A frosted command surface: a search box at the top and the shortcut catalog
// below (no visible title bar). Opened from anywhere with ⌘/ (see
// use-shortcuts-hotkey.ts); dismissed by Escape, click-away, or ⌘/ again.
//
// Two modes:
//   • Browse (no query) — horizontal category tabs (the same pill chrome as
//     the chat / terminal / workbench tab strips: no border, bg fill + fg1 when
//     active); the active tab's shortcuts are listed below (the tab is the
//     category label, so rows carry no tag).
//   • Search (query typed) — tabs hide; every matching shortcut is listed flat,
//     each row tagged with its category. cmdk does the filtering + nav.
//
// The rows are VIEW-ONLY: no hover / selected highlight (the shared cmdk
// CommandItem's data-[selected] fill is overridden to transparent) and nothing
// to activate — the palette is a reference surface.
//
// It composes cmdk inside the raw Radix Dialog primitives — NOT the shared
// <CommandDialog> — for two reasons:
//   1. a lighter scrim (bg-scrim/30, no full-screen blur) so the app frosts
//      *through* the panel instead of hiding behind the modal's 80% veil, and
//   2. glass on the panel itself: a --bg2 wash (30%) + a STRONG, smooth
//      backdrop blur that melts the app behind into clean colour — thick
//      glass, not a thin film and not a milky frost. The inner cmdk root is forced
//      transparent (bg-transparent overrides its default opaque bg-bg3) so
//      the glass shows through.
// Both light and dark themes come for free — every class is a token utility.
// ──────────────────────────────────────────────────────────

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/renderer/shared/ui/primitives/command";
import { Kbd } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";

import { SHORTCUT_CATEGORIES, shortcutSearchValue } from "./shortcuts-catalog";

export interface ShortcutsPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutsPalette({ open, onOpenChange }: ShortcutsPaletteProps) {
  const [query, setQuery] = React.useState("");
  const [activeCategoryId, setActiveCategoryId] = React.useState(
    SHORTCUT_CATEGORIES[0].id,
  );
  const searching = query.trim().length > 0;

  // Fresh state each time it opens: cleared search, first tab selected.
  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActiveCategoryId(SHORTCUT_CATEGORIES[0].id);
    }
  }, [open]);

  const activeCategory =
    SHORTCUT_CATEGORIES.find((c) => c.id === activeCategoryId) ??
    SHORTCUT_CATEGORIES[0];

  // Browse (no query): the active tab's shortcuts, no category tag. Searching:
  // every shortcut, flat, each carrying its category tag (cmdk filters them).
  const rows = searching
    ? SHORTCUT_CATEGORIES.flatMap((category) =>
        category.shortcuts.map((shortcut) => ({ shortcut, category })),
      )
    : activeCategory.shortcuts.map((shortcut) => ({
        shortcut,
        category: activeCategory,
      }));

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* Light scrim only — dims the app a touch so the glass reads, but
            keeps it visible through the panel (no full-screen blur). */}
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-scrim/30",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        />
        <DialogPrimitive.Content
          aria-label="Keyboard shortcuts"
          className={cn(
            // Dead-center both axes. FIXED height (not max-h): the panel is
            // the same size on every tab / search state — no height jumps —
            // and stays responsive to the window through the 72vh term.
            // 344px = eight visible shortcut rows: input 36 (h-9) + tabs 44
            // (py-2 + h-7) + list padding 8 + 8 × 32px rows; 660px wide keeps
            // the previous 600×312 proportion. Overflowing content scrolls
            // in the list (flex-col + min-h-0).
            "fixed left-1/2 top-1/2 z-50 flex w-[92vw] max-w-[660px] -translate-x-1/2 -translate-y-1/2 flex-col",
            "h-[min(72vh,344px)]",
            "overflow-hidden rounded-lg border border-border2/60 shadow-[var(--shadow-dropdown)]",
            // Thick glass (tuned to the user's reference): a --bg2 wash for
            // warmth + a STRONG smooth blur that melts the app behind into clean
            // colour — not a thin see-through film, not a milky frost (milk = too
            // little tint + too much saturate; deep glass = the reverse). Levers:
            // blur = glass thickness; bg2 alpha = warmth/body; and note --bg2 ≈
            // the app's own luminance, so it's the SCRIM (not the tint) that
            // actually darkens the panel — deepen bg-scrim if you want it darker.
            "bg-bg2/30 backdrop-blur-[28px] backdrop-saturate-[1.2]",
            // Subtle scale-from-center on open/close (matches dialog.tsx). The
            // panel is centered with the negative translate-x / translate-y
            // half utilities, which in Tailwind v4 are the standalone
            // `translate` property — separate from the `transform`
            // tw-animate-css animates — so it stays put through the zoom. Do
            // NOT re-add the slide-in helpers: those double the -50% into the
            // animated transform and fling the panel to the top-left (see the
            // long note in dialog.tsx). `origin-center` + zoom keeps it pinned
            // to the middle.
            "origin-center duration-200 ease-out data-[state=closed]:duration-150 data-[state=closed]:ease-in",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-97 data-[state=closed]:zoom-out-97",
          )}
        >
          {/* Radix a11y: labelled + described, nothing visible (no title bar). */}
          <DialogPrimitive.Title className="sr-only">
            Keyboard shortcuts
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search and browse every keyboard shortcut.
          </DialogPrimitive.Description>

          {/* bg-transparent overrides the cmdk root's opaque bg-bg3 so the
              panel glass shows through the list; min-h-0 lets the root shrink
              inside the capped panel so CommandList (flex-1) scrolls. */}
          <Command className="min-h-0 bg-transparent">
            <CommandInput
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search shortcuts…"
            />

            {/* Category tabs — hidden while searching (results span every
                category and carry their own tag instead). */}
            {!searching && (
              <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 py-2">
                {SHORTCUT_CATEGORIES.map((category) => {
                  const active = category.id === activeCategoryId;
                  return (
                    <button
                      key={category.id}
                      type="button"
                      onClick={() => setActiveCategoryId(category.id)}
                      // The app-wide tab pill (chat / terminal / workbench
                      // strips): h-7 rounded-md, no border, fill + fg1 when
                      // active or hovered — but the fill is the TRANSLUCENT
                      // --selected-glass semantic token (semantic-tokens.css)
                      // so the pill stays glassy on the frosted panel.
                      className={cn(
                        "flex h-7 shrink-0 cursor-pointer select-none items-center rounded-md px-2.5 text-xs font-medium transition-colors",
                        active
                          ? "bg-[var(--selected-glass)] text-fg1"
                          : "text-fg2 hover:bg-[var(--selected-glass)] hover:text-fg1",
                      )}
                    >
                      {category.label}
                    </button>
                  );
                })}
              </div>
            )}

            <CommandList className="max-h-none min-h-0 flex-1 p-1">
              <CommandEmpty className="text-fg2">
                No shortcuts found.
              </CommandEmpty>
              {rows.map(({ shortcut, category }) => (
                <CommandItem
                  key={shortcut.id}
                  value={shortcutSearchValue(shortcut, category)}
                  // View-only: kill the primitive's hover/selected fill so the
                  // reference list never looks actionable.
                  className="data-[selected=true]:bg-transparent"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-fg1">
                    {shortcut.label}
                  </span>
                  {/* Chips share the tabs' translucent --selected-glass wash
                      so they stay glassy on the frosted panel. The Kbd here
                      also drops its border (this palette only — everywhere
                      else Kbd keeps border1): the wash alone is the chip. */}
                  {searching && (
                    <span className="shrink-0 rounded-sm bg-[var(--selected-glass)] px-1.5 py-px text-3xxs font-medium text-fg2">
                      {category.label}
                    </span>
                  )}
                  <span className="flex shrink-0 items-center gap-1">
                    {shortcut.keys.map((chord) => (
                      <Kbd
                        key={chord}
                        className="border-transparent bg-[var(--selected-glass)]"
                      >
                        {chord}
                      </Kbd>
                    ))}
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
