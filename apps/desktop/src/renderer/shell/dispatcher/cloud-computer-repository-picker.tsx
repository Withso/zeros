import { ChevronDown, Plus } from "lucide-react";
import type { CloudComputerV2ActiveRepository } from "@zeros/protocol/cloud-computer-v2";
import { Button, GithubIcon } from "../../shared/ui";
import { Tooltip } from "../../shared/ui/primitives";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
}: {
  repositories: CloudComputerV2ActiveRepository[];
  selected: CloudComputerV2ActiveRepository | null;
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  onSelect: (id: string) => void;
  warm: (repository: CloudComputerV2ActiveRepository) => void;
}) {
  const dispatch = useWorkspaceDispatch();
  return (
    <DropdownMenu
      open={active && !disabled && open}
      onOpenChange={onOpenChange}
    >
      <Tooltip label="Choose project">
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
                : "Add repository"}
            </span>
            <ChevronDown size={12} className="text-fg2 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="min-w-[220px]"
      >
        {repositories.map((repository) => (
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
        ))}
        {repositories.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem
          onSelect={() => {
            requestUserSettingsSection("cloud-computer");
            dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
          }}
        >
          <Plus className="text-fg2" strokeWidth={1.5} />
          <span>Add repository</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
