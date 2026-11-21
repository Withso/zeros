// Create's cloud project: the organization's projects, then the ones only this
// member uses, then New project and Manage projects. A project of several
// repositories shows "N repos", each with its own branch and, for its editors,
// Add repositories.
import { useState } from "react";
import { Check, ChevronDown, GitBranch, Plus, Settings } from "lucide-react";
import { Button, GithubIcon } from "../../shared/ui";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import type { CloudProject, CloudProjects } from "../../platform/cloud-github-levels";
import { requestUserSettingsSection } from "../../features/settings/settings-navigation";
import { useWorkspaceDispatch } from "../../state/store";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { computerBranchesCache, GITHUB_READ_MAX_AGE_MS } from "../../state/read-caches";
import { computerSourceReadKey, readComputerBranches } from "./cloud-computer-source";

/** The organization's projects, then this member's own; each group by name. */
export function cloudProjectGroups(projects: readonly CloudProject[], organizationName: string) {
  return [
    { label: organizationName, rows: projects.filter(project => project.level === "organization") },
    { label: "Only you", rows: projects.filter(project => project.level === "personal") },
  ].filter(group => group.rows.length > 0);
}

export function CloudProjectPicker({ projects, selected, rememberedId, organizationName, active, open, onOpenChange, disabled, onSelect, warm, onNewProject }: {
  projects: CloudProjects; selected: CloudProject | null; rememberedId: string | null; organizationName: string;
  active: boolean; open: boolean; onOpenChange(open: boolean): void; disabled: boolean;
  onSelect(id: string): void; warm(projectId: string): void; onNewProject: (() => void) | null;
}) {
  const dispatch = useWorkspaceDispatch();
  return (
    <DropdownMenu open={active && !disabled && open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" aria-label="Choose project" disabled={disabled}
          onPointerEnter={() => { if (active && selected) warm(selected.id); }} onFocus={() => { if (active && selected) warm(selected.id); }}
          className="text-fg2 h-7 min-w-0 gap-1.5 px-2 text-sm font-normal hover:bg-transparent">
          <span className="max-w-[180px] truncate">{selected?.name ?? (rememberedId ? "Project" : "Choose project")}</span>
          <ChevronDown size={12} className="text-fg2 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-[240px]">
        {cloudProjectGroups(projects.projects, organizationName).map((group, index) => (
          <div key={group.label} role="group" aria-label={group.label}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{`${group.label} · ${group.rows.length}`}</DropdownMenuLabel>
            {group.rows.map(project => (
              <DropdownMenuItem key={project.id} data-selected={project.id === selected?.id || undefined}
                onPointerEnter={() => warm(project.id)} onFocus={() => warm(project.id)} onSelect={() => onSelect(project.id)}>
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {project.repositories.length > 1 && <span className="text-fg3 text-xs">{`${project.repositories.length} repos`}</span>}
                {project.id === selected?.id ? <Check className="text-fg1 size-3.5" aria-label="Selected" /> : <span className="size-3.5" />}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        <DropdownMenuSeparator />
        {onNewProject && (
          <DropdownMenuItem onSelect={onNewProject}><Plus className="text-fg2" strokeWidth={1.5} /><span>New project</span></DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => { requestUserSettingsSection("cloud-computer"); dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" }); }}>
          <Settings className="text-fg2" strokeWidth={1.5} /><span>Manage projects</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "N repos": each repository with the branch its workspace starts from; the
 * first's choice is Create's own source selection. */
export function CloudProjectRepositoriesMenu({ project, firstBranch, bases, userKey, active, disabled, onBase, onAddRepositories }: {
  project: CloudProject; firstBranch: string | null; bases: Readonly<Record<string, string>>; userKey: string; active: boolean; disabled: boolean;
  onBase(repository: string, branch: string | null): void; onAddRepositories: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={active && !disabled && open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" aria-label={`${project.repositories.length} repositories`} disabled={disabled}
          className="text-fg2 h-7 min-w-0 gap-1.5 px-2 text-sm font-normal hover:bg-transparent">
          <GithubIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{`${project.repositories.length} repos`}</span>
          <ChevronDown size={12} className="text-fg2 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-[280px]">
        {project.repositories.map((entry, index) => {
          const branch = index === 0 ? firstBranch : bases[entry.repository.toLowerCase()] ?? null;
          return (
            <DropdownMenuSub key={entry.repository}>
              <DropdownMenuSubTrigger>
                <GithubIcon className="text-fg2 size-3.5" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{entry.repository}</span>
                <span className="text-fg3 text-xs">{branch ?? entry.defaultBranch ?? "default"}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 min-w-[200px] overflow-y-auto">
                <RepositoryBranches userKey={userKey} entry={entry} active={active && open} chosen={branch}
                  onChoose={next => onBase(entry.repository, next)} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
        {onAddRepositories && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onAddRepositories}><Plus className="text-fg2" strokeWidth={1.5} /><span>Add repositories</span></DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RepositoryBranches({ userKey, entry, active, chosen, onChoose }: {
  userKey: string; entry: CloudProject["repositories"][number]; active: boolean; chosen: string | null; onChoose(branch: string | null): void;
}) {
  const [owner, name] = entry.repository.split("/") as [string, string];
  const key = computerSourceReadKey(JSON.stringify([userKey, "project"]), { id: entry.repositoryId, owner, name, defaultBranch: null });
  const read = useRecoveringRead(computerBranchesCache, key, readComputerBranches, { enabled: active, maxAgeMs: GITHUB_READ_MAX_AGE_MS });
  const fallback = entry.defaultBranch ?? "default";
  return (
    <>
      <DropdownMenuItem onSelect={() => onChoose(null)}>
        <GitBranch className="text-fg2 size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{`Project's branch (${fallback})`}</span>
        {chosen === null && <Check className="text-fg1 size-3.5" aria-label="Selected" />}
      </DropdownMenuItem>
      {!read.data && <DropdownMenuLabel>{read.error ? "Couldn't read branches" : "Reading branches…"}</DropdownMenuLabel>}
      {(read.data ?? []).slice(0, 100).map(branch => (
        <DropdownMenuItem key={branch.name} onSelect={() => onChoose(branch.name)}>
          <GitBranch className="text-fg2 size-3.5" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{branch.name}</span>
          {chosen === branch.name && <Check className="text-fg1 size-3.5" aria-label="Selected" />}
        </DropdownMenuItem>
      ))}
    </>
  );
}
