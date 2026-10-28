// ──────────────────────────────────────────────────────────
// ShortcutsPalette — the ⌥⌘/ glass shortcuts menu
// ──────────────────────────────────────────────────────────
//
// A frosted command surface: a full-width search box at the top and the shortcut
// catalog below it, with an accessibility-only title. Opened with ⌥⌘/ (see
// use-shortcuts-hotkey.ts); dismissed by Escape, click-away, or ⌥⌘/ again.
//
// Two modes:
//   • Browse (no query) — horizontal category pills (no border, bg fill + fg1
//     when active); the active tab's shortcuts are listed below (the tab is the
//     category label, so rows carry no tag).
//   • Search (query typed) — tabs hide; every matching shortcut is listed flat,
//     each row tagged with its category. cmdk does the filtering + nav.
//
// The rows are VIEW-ONLY: no hover / selected highlight (the shared cmdk
// CommandItem's data-[selected] fill is overridden to transparent) and nothing
// to activate — the palette is a reference surface.
//
// The shared dialog owns focus, dismissal and the 50% modal scrim.
// The command surface retains its translucent panel and backdrop blur.
// ──────────────────────────────────────────────────────────

import * as React from "react";
import {
  PaletteDialog,
  PaletteCommand,
  PaletteCategoryButton,
} from "../shared/ui/primitives/palette-dialog";

import {
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/renderer/shared/ui/primitives/command";
import { Kbd } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";

import { SHORTCUT_CATEGORIES, shortcutSearchValue } from "./shortcuts-catalog";
import { Inline } from "@/renderer/shared/ui/layout/inline";

export interface ShortcutsPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutsPalette({
  open,
  onOpenChange,
}: ShortcutsPaletteProps) {
  const searchRef = React.useRef<HTMLInputElement>(null);
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
    <PaletteDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      description="Search and browse every keyboard shortcut."
    >
      <PaletteCommand>
        <CommandInput
          ref={searchRef}
          autoFocus
          showSearchIcon={false}
          value={query}
          onValueChange={setQuery}
          aria-label="Search shortcuts"
          placeholder="Search shortcuts…"
          className="h-12 text-sm"
        />

        {/* Category tabs — hidden while searching (results span every
                  category and carry their own tag instead). */}
        {!searching && (
          <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 py-2">
            {SHORTCUT_CATEGORIES.map((category) => {
              const active = category.id === activeCategoryId;
              return (
                <PaletteCategoryButton
                  key={category.id}
                  searchRef={searchRef}
                  type="button"
                  variant="ghost"
                  aria-pressed={active}
                  onClick={() => setActiveCategoryId(category.id)}
                  // Rounded category pills: h-7, no border, fill + fg1 when
                  // active or hovered. The fill is the TRANSLUCENT
                  // --selected-glass semantic token (semantic-tokens.css)
                  // so the pill stays glassy on the frosted panel.
                  className={cn(
                    "flex h-7 shrink-0 cursor-pointer items-center rounded-full border-0 px-2.5 text-xs font-medium transition-colors select-none hover:bg-[var(--selected-glass)] hover:text-fg1",
                    active
                      ? "text-fg1 bg-[var(--selected-glass)]"
                      : "text-fg2 hover:text-fg1 hover:bg-[var(--selected-glass)]",
                  )}
                >
                  {category.label}
                </PaletteCategoryButton>
              );
            })}
          </div>
        )}

        <CommandList className="max-h-none min-h-0 flex-1 p-1">
          <CommandEmpty className="text-fg2">No shortcuts found.</CommandEmpty>
          {rows.map(({ shortcut, category }) => (
            <CommandItem
              key={shortcut.id}
              value={shortcutSearchValue(shortcut, category)}
              // View-only: kill the primitive's hover/selected fill so the
              // reference list never looks actionable.
              className="data-[selected=true]:bg-transparent"
            >
              <span className="text-fg1 min-w-0 flex-1 truncate text-sm">
                {shortcut.label}
              </span>
              {/* Chips share the tabs' translucent --selected-glass wash
                        so they stay glassy on the frosted panel. The Kbd here
                        also drops its border (this palette only — everywhere
                        else Kbd keeps border1): the wash alone is the chip. */}
              {searching && (
                <span className="text-3xxs text-fg2 shrink-0 rounded-sm bg-[var(--selected-glass)] px-1.5 py-px font-medium">
                  {category.label}
                </span>
              )}
              <Inline as="span" gap={1} align="center" className="shrink-0">
                {shortcut.keys.map((chord) => (
                  <Kbd
                    key={chord}
                    className="border-transparent bg-[var(--selected-glass)]"
                  >
                    {chord}
                  </Kbd>
                ))}
              </Inline>
            </CommandItem>
          ))}
        </CommandList>
      </PaletteCommand>
    </PaletteDialog>
  );
}
