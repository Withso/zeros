import { useMemo, useRef } from "react";
import { ChevronRight, Play } from "lucide-react";
import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives";
import { DynamicIcon } from "../../shared/ui/icon-registry";
import { useRunControl } from "../terminal/use-run-control";
import { SETUP_SUBTAB } from "../terminal/use-setup-control";
import { useActiveWorkspace } from "../../state/use-active-workspace";
import {
  searchEnvironmentTerminals,
  type QuickOpenEnvironmentEntry,
} from "./quick-open";

// The add-menu reference uses a wider corner radius than ordinary menus.
// Keep that requested geometry local; the shared menu scale is unchanged.
export const NEW_TAB_MENU_CHROME =
  "w-[280px] rounded-[calc(var(--radius-lg)*2)]";

export function NewTabEnvironmentMenu({
  open,
  onOpenChange,
  terminalFolder,
  cwd,
  onSelect,
  restoreSearchFocus,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  terminalFolder: string;
  cwd?: string;
  onSelect(terminalId: string, title: string): void;
  restoreSearchFocus(): void;
}) {
  const triggerRef = useRef<HTMLDivElement | null>(null);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <CommandItem
          ref={triggerRef}
          value="environment"
          onSelect={() => onOpenChange(true)}
          onPointerEnter={() => onOpenChange(true)}
          onPointerDown={(event) => {
            // This row enters a submenu. Pressing it while hovered must not
            // toggle the already-open submenu closed before click reopens it.
            event.preventDefault();
            onOpenChange(true);
          }}
          aria-label="Environment"
        >
          <Play className="size-4" />
          <span>Environment</span>
          <ChevronRight className="text-fg2 ml-auto size-4" aria-hidden />
        </CommandItem>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className={`${NEW_TAB_MENU_CHROME} max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto`}
        aria-label="Environment terminals"
        aria-labelledby={undefined}
        onPointerDownOutside={(event) => {
          // The parent row is an entry into this menu, not an outside dismiss.
          if (triggerRef.current?.contains(event.target as Node))
            event.preventDefault();
        }}
        onKeyDown={(event) => {
          // A portaled child menu must not also navigate the parent command list.
          event.stopPropagation();
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            onOpenChange(false);
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreSearchFocus();
        }}
      >
        <EnvironmentItems
          terminalFolder={terminalFolder}
          cwd={cwd}
          onSelect={onSelect}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EnvironmentItems({
  terminalFolder,
  cwd,
  onSelect,
}: {
  terminalFolder: string;
  cwd?: string;
  onSelect(terminalId: string, title: string): void;
}) {
  const { entries } = useEnvironmentEntries(terminalFolder, cwd);
  return (
    <>
      {entries.map((entry) => (
        <DropdownMenuItem
          key={entry.terminalId}
          onSelect={() => onSelect(entry.terminalId, entry.title)}
        >
          <DynamicIcon name={entry.icon} className="text-fg2 size-4" />
          <span className="min-w-0 truncate">{entry.title}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

export function NewTabEnvironmentSearchResults({
  terminalFolder,
  cwd,
  query,
  onSelect,
  showEmpty,
}: {
  terminalFolder: string;
  cwd?: string;
  query: string;
  onSelect(terminalId: string, title: string): void;
  showEmpty: boolean;
}) {
  const { entries, ready } = useEnvironmentEntries(terminalFolder, cwd);
  const results = useMemo(
    () => searchEnvironmentTerminals(entries, query),
    [entries, query],
  );
  if (results.length === 0) {
    return showEmpty && ready ? (
      <CommandEmpty>
        No matching files, pages, or environment terminals.
      </CommandEmpty>
    ) : null;
  }
  return (
    <CommandGroup heading="Environment">
      {results.map((entry) => (
        <CommandItem
          key={entry.terminalId}
          value={`environment:${entry.terminalId}`}
          onSelect={() => onSelect(entry.terminalId, entry.title)}
        >
          <DynamicIcon name={entry.icon} className="text-fg2 size-4" />
          <span className="min-w-0 truncate">{entry.title}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function useEnvironmentEntries(terminalFolder: string, cwd?: string) {
  // Both consumers mount only while useful and share the terminal controller's
  // exact settings cache and platform filtering. Neither starts a command.
  const { actions, actionsReady, runIdFor } = useRunControl(terminalFolder, cwd);
  const { workspace } = useActiveWorkspace();
  const entries = useMemo<QuickOpenEnvironmentEntry[]>(
    () => [
      { terminalId: SETUP_SUBTAB, title: "Setup", icon: "settings" },
      ...actions.map((action) => ({
        terminalId: runIdFor(action.id),
        title: action.name,
        icon: action.icon ?? "play",
      })),
    ],
    [actions, runIdFor],
  );
  return { entries, ready: actionsReady || !cwd || !workspace };
}
