import { useCallback, useMemo, useRef, useState } from "react";
import { ListFilter, Search } from "lucide-react";
import type { Project } from "../state/projects-store";
import type { SidebarWorkspaceSort } from "../state/sidebar-list-preferences";
import { cn } from "../shared/ui/cn";
import { Button } from "../shared/ui/primitives/button";
import { Input } from "../shared/ui/primitives/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../shared/ui/primitives/dropdown-menu";
import { Tooltip } from "../shared/ui/primitives/tooltip";
import { SIDEBAR_ROW_ACTION_CLS } from "./sidebar-repository-header";
import {
  SIDEBAR_WORKSPACE_LIST_FILTERS,
  type SidebarWorkspaceListFilter,
} from "./sidebar-workspace-model";
import { parseRemote } from "./pr/github-url";

const GROUP_LABELS: Record<SidebarWorkspaceListFilter, string> = {
  grouped: "Repository",
  status: "Status",
  ungrouped: "None",
};

export function SidebarWorkspaceMenu({
  active,
  projects,
  grouping,
  sort,
  repositoryIds,
  onGroupingChange,
  onSortChange,
  onRepositoryIdsChange,
}: {
  active: boolean;
  projects: readonly Project[];
  grouping: SidebarWorkspaceListFilter;
  sort: SidebarWorkspaceSort;
  repositoryIds: readonly string[];
  onGroupingChange: (value: SidebarWorkspaceListFilter) => void;
  onSortChange: (value: SidebarWorkspaceSort) => void;
  onRepositoryIdsChange: (value: readonly string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const repoTriggerRef = useRef<HTMLDivElement>(null);
  const repoContentRef = useRef<HTMLDivElement | null>(null);
  const initializedNodes = useRef(new WeakSet<HTMLDivElement>());
  const setRepoContent = useCallback((node: HTMLDivElement | null) => {
    repoContentRef.current = node;
    if (node && !initializedNodes.current.has(node)) {
      initializedNodes.current.add(node);
      queueMicrotask(() => {
        if (repoContentRef.current === node && node.dataset.state === "open")
          searchRef.current?.focus();
      });
    }
  }, []);
  const selected = new Set(repositoryIds);
  const search = query.trim().toLocaleLowerCase();
  const repositories = useMemo(
    () =>
      projects.map((project) => {
        const remote = parseRemote(project.originUrl);
        return {
          project,
          label: remote ? `${remote.owner}/${remote.repo}` : project.name,
        };
      }),
    [projects],
  );
  const matching = repositories.filter(({ project, label }) =>
    `${label} ${project.name} ${project.repoSlug}`
      .toLocaleLowerCase()
      .includes(search),
  );
  const filtered = repositoryIds.length > 0;

  return (
    <DropdownMenu
      open={active && open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) {
          setRepoOpen(false);
          setQuery("");
        }
      }}
    >
      <Tooltip label="Filter workspaces" side="bottom" delayDuration={1500} disabled={open}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-compact"
            className={cn(
              SIDEBAR_ROW_ACTION_CLS,
              !open &&
                !filtered &&
                "opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100",
            )}
            aria-label="Filter workspaces"
            data-filtered={filtered || undefined}
          >
            <ListFilter strokeWidth={1.5} />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        sideOffset={5}
        className="w-52"
        aria-label="Workspace display options"
      >
        <DropdownMenuLabel className="text-fg3 font-normal">
          Group
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={grouping}
          onValueChange={(value) =>
            onGroupingChange(value as SidebarWorkspaceListFilter)
          }
          aria-label="Group"
        >
          {SIDEBAR_WORKSPACE_LIST_FILTERS.map((value) => (
            <DropdownMenuRadioItem
              key={value}
              value={value}
              indicator="check"
              indicatorSide="end"
            >
              {GROUP_LABELS[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span>Filter</span>
            <span className="text-fg3 text-3xxs ml-auto">
              {filtered ? `${repositoryIds.length} selected` : "None"}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className="w-44"
            aria-label="Workspace filters"
          >
            <DropdownMenuSub
              open={repoOpen}
              onOpenChange={(value) => {
                setRepoOpen(value);
                if (!value) setQuery("");
              }}
            >
              <DropdownMenuSubTrigger ref={repoTriggerRef}>
                Repo
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                ref={setRepoContent}
                className="w-64"
                aria-label="Filter by repository"
              >
                <div className="flex items-center gap-1 px-1 py-1">
                  <Search
                    className="text-fg3 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <Input
                    ref={searchRef}
                    type="search"
                    aria-label="Search repositories"
                    placeholder="Search repositories…"
                    className="min-w-0 text-xs"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      // Text input must not feed Radix's menu typeahead or its
                      // Left/Right submenu keys. Up/Down enter the result list.
                      if (event.key !== "Tab") event.stopPropagation();
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setRepoOpen(false);
                        repoTriggerRef.current?.focus();
                      } else if (
                        event.key === "ArrowDown" ||
                        event.key === "ArrowUp"
                      ) {
                        event.preventDefault();
                        const items =
                          repoContentRef.current?.querySelectorAll<HTMLElement>(
                            '[role="menuitemcheckbox"]',
                          );
                        const index =
                          event.key === "ArrowDown"
                            ? 0
                            : (items?.length ?? 0) - 1;
                        items?.[index]?.focus();
                      }
                    }}
                  />
                </div>
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    onRepositoryIdsChange([]);
                  }}
                >
                  All repositories
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {matching.map(({ project, label }) => (
                  <DropdownMenuCheckboxItem
                    key={project.id}
                    checked={selected.has(project.id)}
                    indicatorSide="end"
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) =>
                      onRepositoryIdsChange(
                        checked
                          ? [...repositoryIds, project.id]
                          : repositoryIds.filter((id) => id !== project.id),
                      )
                    }
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{label}</span>
                      {repositories.some(
                        (other) =>
                          other.project.id !== project.id &&
                          other.label === label,
                      ) && (
                        <span className="text-muted-fg text-3xxs block truncate">
                          {project.repoRoot}
                        </span>
                      )}
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
                {matching.length === 0 && (
                  <div className="text-fg3 px-2 py-2 text-xs" role="status">
                    No repositories found
                  </div>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Sort by</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-40" aria-label="Sort workspaces">
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(value) =>
                onSortChange(value as SidebarWorkspaceSort)
              }
              aria-label="Sort by"
            >
              <DropdownMenuRadioItem
                value="updated"
                indicator="check"
                indicatorSide="end"
              >
                Updated
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                value="created"
                indicator="check"
                indicatorSide="end"
              >
                Created
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
