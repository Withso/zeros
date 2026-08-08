// ──────────────────────────────────────────────────────────
// IconPicker — searchable Lucide-icon grid in a Popover
// ──────────────────────────────────────────────────────────
//
// The run-action icon chooser (Settings → Run actions): a trigger button
// showing the current icon opens a Popover with the shared command-search
// treatment over the curated registry grid (icon-registry.tsx). Selection
// stores the icon's Lucide NAME string. The original grid stays intact; only
// its search field uses the shared command-search chrome (without a glyph).
// ──────────────────────────────────────────────────────────

import { useMemo, useState } from "react";

import { cn } from "./cn";
import { Button } from "./primitives/button";
import { Command, CommandInput, CommandList } from "./primitives/command";
import { Popover, PopoverContent, PopoverTrigger } from "./primitives/popover";
import { Tooltip } from "./primitives/tooltip";
import { DEFAULT_RUN_ICON, DynamicIcon, RUN_ICONS } from "./icon-registry";

export function IconPicker({
  value,
  onChange,
  label = "Choose icon",
}: {
  /** The selected icon's Lucide name (falls back to the default glyph). */
  value: string | undefined;
  onChange: (name: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return RUN_ICONS;
    return RUN_ICONS.filter(
      (icon) =>
        icon.name.includes(q) ||
        icon.keywords.some((keyword) => keyword.includes(q)),
    );
  }, [query]);
  const selected = value || DEFAULT_RUN_ICON;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Tooltip label={label}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={label}>
            <DynamicIcon name={selected} className="size-4" />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="start" className="w-56 overflow-hidden p-0">
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search icons"
            aria-label="Search icons"
            showSearchIcon={false}
          />
          <CommandList aria-label="Icons" className="max-h-none">
            <div className="grid grid-cols-6 gap-1 p-2">
              {filtered.map((icon) => (
                <Tooltip key={icon.name} label={icon.name}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={icon.name === selected}
                    onClick={() => {
                      onChange(icon.name);
                      setOpen(false);
                    }}
                    className={cn(
                      "text-fg2 inline-flex size-7 items-center justify-center rounded-sm transition-colors",
                      "hover:bg-bg2-hover hover:text-fg1",
                      "focus-visible:ring-highlighted-bright focus-visible:ring-1 focus-visible:outline-none",
                      icon.name === selected && "bg-bg2-hover text-fg1",
                    )}
                  >
                    <icon.Icon className="size-4" strokeWidth={1} />
                  </button>
                </Tooltip>
              ))}
              {filtered.length === 0 && (
                <div className="text-muted-fg col-span-6 py-3 text-center text-xs">
                  No icons match
                </div>
              )}
            </div>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
