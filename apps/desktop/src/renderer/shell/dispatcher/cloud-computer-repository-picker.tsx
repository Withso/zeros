import { ChevronDown, Plus, Settings } from "lucide-react";
import type { CloudComputerRepository } from "../../features/settings/cloud-computer-v2-create-gate";
import { Button, GithubIcon } from "../../shared/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { requestUserSettingsSection } from "../../features/settings/settings-navigation";
import { useWorkspaceDispatch } from "../../state/store";

export function CloudComputerRepositoryPicker({
  repositories,
  selected,
  active,
  open,
  onOpenChange,
  disabled,
  onSelect,
  warm,
  rememberedId,
  manage = false,
  organizationName,
  manageSection,
}: {
  repositories: readonly CloudComputerRepository[];
  selected: CloudComputerRepository | null;
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  onSelect: (id: string) => void;
  warm: (repository: CloudComputerRepository) => void;
  rememberedId?: string | null;
  /** unified-workspaces: repositories are managed in Settings, never added from Create. */
  manage?: boolean;
  /** Two GitHub levels: the shared list's heading, and where Manage repositories opens. */
  organizationName?: string;
  manageSection?: "cloud-computer" | "org-github" | "integrations";
}) {
  const dispatch = useWorkspaceDispatch();
  const leveled = repositories.some(repository => repository.level);
  const groups = leveled
    ? [{ label: organizationName ?? "Organization", rows: repositories.filter(repository => repository.level !== "private") },
      { label: "Only you", rows: repositories.filter(repository => repository.level === "private") }].filter(group => group.rows.length)
    : [{ label: null, rows: repositories }];
  const item = (repository: CloudComputerRepository) => (
    <DropdownMenuItem
      key={repository.id}
      data-selected={repository.id === selected?.id || undefined}
      onPointerEnter={() => warm(repository)}
      onFocus={() => warm(repository)}
      onSelect={() => onSelect(repository.id)}
    >
      <GithubIcon className="text-fg2 size-3.5" aria-hidden="true" />
      <span className="truncate">
        {repository.owner}/{repository.name}
      </span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu
      open={active && !disabled && open}
      onOpenChange={onOpenChange}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          aria-label="Choose project"
          disabled={disabled}
          onPointerEnter={() => {
            if (active && selected) warm(selected);
          }}
          onFocus={() => {
            if (active && selected) warm(selected);
          }}
          className="text-fg2 h-7 min-w-0 gap-1.5 px-2 text-sm font-normal hover:bg-transparent"
        >
          <GithubIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="max-w-[180px] truncate">
            {selected
              ? `${selected.owner}/${selected.name}`
              : rememberedId ?? "Choose repository"}
          </span>
          <ChevronDown size={12} className="text-fg2 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="min-w-[220px]"
      >
        {groups.map((group, index) => (
          <div key={group.label ?? "all"} role="group" aria-label={group.label ?? undefined}>
            {index > 0 && <DropdownMenuSeparator />}
            {group.label && <DropdownMenuLabel>{group.label}</DropdownMenuLabel>}
            {group.rows.map(item)}
          </div>
        ))}
        {repositories.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem
          onSelect={() => {
            requestUserSettingsSection(manageSection ?? "cloud-computer");
            dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
          }}
        >
          {manage ? <Settings className="text-fg2" strokeWidth={1.5} /> : <Plus className="text-fg2" strokeWidth={1.5} />}
          <span>{manage ? "Manage repositories" : "Add repository"}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
