import { useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Cloud,
  Copy,
  CornerDownLeft,
  File,
  Folder,
  GitCompareArrows,
  GitPullRequest,
  Globe,
  Home,
  Keyboard,
  MessageCircle,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  Settings,
  SlidersHorizontal,
  Sun,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import {
  PaletteCommand,
  PaletteCategoryButton,
  PaletteDialog,
} from "../shared/ui/primitives/palette-dialog";
import { Button, Kbd } from "../shared/ui/primitives";
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../shared/ui/primitives/command";
import { cn } from "../shared/ui/cn";
import {
  PALETTE_CATEGORIES,
  selectPaletteEntries,
  type PaletteCategory,
  type PaletteEntry,
  type PaletteIcon,
  type PaletteWorkspaceFilter,
} from "./command-palette-model";

const ICONS: Record<PaletteIcon, LucideIcon> = {
  workspace: Folder,
  cloud: Cloud,
  chat: MessageCircle,
  file: File,
  home: Home,
  plus: Plus,
  folder: Folder,
  settings: Settings,
  keyboard: Keyboard,
  feedback: MessageCircle,
  sidebar: PanelLeft,
  workbench: PanelRight,
  terminal: Terminal,
  browser: Globe,
  changes: GitCompareArrows,
  review: GitPullRequest,
  copy: Copy,
  customize: SlidersHorizontal,
  sun: Sun,
  moon: Moon,
  system: Monitor,
};

export interface CommandPaletteProps {
  entries: PaletteEntry[];
  query: string;
  onQueryChange: (query: string) => void;
  category: PaletteCategory;
  onCategoryChange: (category: PaletteCategory) => void;
  workspaceFilter: PaletteWorkspaceFilter;
  onWorkspaceFilterChange: (filter: PaletteWorkspaceFilter) => void;
  loading?: boolean;
  notice?: string;
  onRetry?: () => void;
  onDismiss: () => void;
  /** False rejects a row whose owner or availability changed before the click. */
  onSelect: (entry: PaletteEntry) => boolean;
  onIntent?: (entry: PaletteEntry) => void;
}

/** Mounted only for an open session: query, selection and focus are ephemeral. */
export function CommandPalette({
  entries,
  query,
  onQueryChange,
  category,
  onCategoryChange,
  workspaceFilter,
  onWorkspaceFilterChange,
  loading,
  notice,
  onRetry,
  onDismiss,
  onSelect,
  onIntent,
}: CommandPaletteProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState("");
  const priorFocus = useRef(document.activeElement);
  const restoreFocus = useRef(true);
  const rows = useMemo(
    () => selectPaletteEntries(entries, category, query),
    [entries, category, query],
  );
  const selected = rows.some((row) => row.id === selection)
    ? selection
    : (rows[0]?.id ?? "");
  const groups = useMemo(() => {
    const result = new Map<string, PaletteEntry[]>();
    for (const row of rows) {
      const group = result.get(row.group) ?? [];
      group.push(row);
      result.set(row.group, group);
    }
    return [...result];
  }, [rows]);
  const changeCategory = (next: PaletteCategory) => {
    setSelection("");
    onCategoryChange(next);
  };

  return (
    <PaletteDialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      title="Command palette"
      description="Find workspaces, chats, files, actions, and settings. Use arrow keys to navigate and Enter to open."
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (
          restoreFocus.current &&
          priorFocus.current instanceof HTMLElement &&
          priorFocus.current.isConnected
        ) {
          priorFocus.current.focus({ preventScroll: true });
        }
      }}
    >
      <PaletteCommand
        shouldFilter={false}
        loop
        value={selected}
        onValueChange={(value) => {
          setSelection(value);
          const entry = rows.find((row) => row.id === value);
          if (entry) onIntent?.(entry);
        }}
      >
        <CommandInput
          ref={searchRef}
          autoFocus
          showSearchIcon={false}
          value={query}
          onValueChange={(value) => {
            setSelection("");
            onQueryChange(value);
          }}
          aria-label="Search commands"
          placeholder={
            PALETTE_CATEGORIES.find((tab) => tab.id === category)?.placeholder
          }
          className="h-12 text-sm"
          onKeyDown={(event) => {
            // Empty search lets Left/Right browse categories; text keeps normal caret navigation.
            if (
              query ||
              event.altKey ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.nativeEvent.isComposing
            )
              return;
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const index = PALETTE_CATEGORIES.findIndex(
              (tab) => tab.id === category,
            );
            const next =
              (index +
                (event.key === "ArrowRight" ? 1 : -1) +
                PALETTE_CATEGORIES.length) %
              PALETTE_CATEGORIES.length;
            changeCategory(PALETTE_CATEGORIES[next].id);
          }}
        />
        <div
          aria-label="Command categories"
          onKeyDown={(event) => {
            if (event.key === "Enter") event.stopPropagation();
          }}
          className="flex shrink-0 flex-wrap items-center gap-1 px-2 py-2"
        >
          {PALETTE_CATEGORIES.map((tab) => (
            <PaletteCategoryButton
              key={tab.id}
              searchRef={searchRef}
              variant="ghost"
              size="sm"
              aria-pressed={category === tab.id}
              onClick={() => changeCategory(tab.id)}
              className={cn(
                "h-7 rounded-full px-2.5 text-xs hover:bg-[var(--selected-glass)]",
                category === tab.id
                  ? "text-fg1 bg-[var(--selected-glass)]"
                  : "text-fg2",
              )}
            >
              {tab.label}
            </PaletteCategoryButton>
          ))}
        </div>
        {category === "workspaces" && (
          <div
            aria-label="Workspace status"
            onKeyDown={(event) => {
              if (event.key === "Enter") event.stopPropagation();
            }}
            className="flex shrink-0 items-center gap-1 px-3 pb-2"
          >
            {(["active", "archived", "all"] as const).map((filter) => (
              <PaletteCategoryButton
                key={filter}
                searchRef={searchRef}
                variant="ghost"
                size="sm"
                aria-pressed={workspaceFilter === filter}
                className={cn(
                  "h-6 px-2 text-xs",
                  workspaceFilter === filter
                    ? "text-fg1 bg-[var(--selected-glass)]"
                    : "text-fg2",
                )}
                onClick={() => {
                  setSelection("");
                  onWorkspaceFilterChange(filter);
                }}
              >
                {filter === "all"
                  ? "All workspaces"
                  : filter === "active"
                    ? "Active"
                    : "Archived"}
              </PaletteCategoryButton>
            ))}
          </div>
        )}
        <CommandList
          aria-label="Command results"
          className="max-h-none min-h-0 flex-1 px-1 pb-1"
        >
          {notice && (
            <div
              role="status"
              onKeyDown={(event) => {
                if (event.key === "Enter") event.stopPropagation();
              }}
              className="text-fg2 flex items-center gap-2 px-3 py-2 text-xs"
            >
              <span>{notice}</span>
              {onRetry && (
                <Button variant="ghost" size="sm" onClick={onRetry}>
                  Retry
                </Button>
              )}
            </div>
          )}
          {rows.length === 0 && !notice && (
            <div
              role="status"
              className="text-fg2 px-4 py-8 text-center text-sm"
            >
              {loading
                ? "Loading results…"
                : query.trim()
                  ? "No results found."
                  : "No results available."}
            </div>
          )}
          {groups.map(([group, items]) => (
            <CommandGroup key={group} heading={group}>
              {items.map((entry) => {
                const Icon = ICONS[entry.icon];
                return (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onPointerEnter={() => onIntent?.(entry)}
                    onFocus={() => onIntent?.(entry)}
                    onSelect={() => {
                      if (onSelect(entry)) {
                        restoreFocus.current = false;
                        onDismiss();
                      }
                    }}
                    className="min-h-9 gap-2.5 rounded-md px-2.5 py-2 data-[selected=true]:bg-[var(--selected-glass)]"
                  >
                    <Icon className="text-fg2 size-4" />
                    <span className="text-fg1 min-w-0 flex-1 truncate text-sm">
                      {entry.label}
                    </span>
                    {entry.detail && (
                      <span className="text-fg2 max-w-[40%] truncate text-xs">
                        {entry.detail}
                      </span>
                    )}
                    {entry.shortcut && (
                      <Kbd className="shrink-0 border-transparent bg-[var(--selected-glass)]">
                        {entry.shortcut}
                      </Kbd>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
        <div
          aria-hidden="true"
          className="border-fg1/15 text-xxs text-fg2 flex h-8 shrink-0 items-center justify-end gap-3 border-t px-3"
        >
          <span className="flex items-center gap-1">
            <ArrowUp className="size-3" />
            <ArrowDown className="size-3" />
            Navigate
          </span>
          <span className="flex items-center gap-1">
            <CornerDownLeft className="size-3" />
            Open
          </span>
          <span>esc Close</span>
        </div>
      </PaletteCommand>
    </PaletteDialog>
  );
}
