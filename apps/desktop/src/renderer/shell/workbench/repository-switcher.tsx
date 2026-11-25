// The current repository of a cloud workspace of several repositories. Shown
// only when the workspace has more than one; Changes, diffs, staging, commit,
// push, pull, the branch pickers, the pull request row and review follow it.
import { ChevronDown } from "lucide-react";
import type { Workspace, WorkspaceRepository } from "../../platform/git";
import { Button, GithubIcon } from "../../shared/ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../shared/ui/primitives";
import { useWorkspaceDispatch, useWorkspaceStore } from "../../state/store";
import { repositoryWorkspace, selectedRepository, workspaceRepositories } from "../../state/workspace-repositories";
import { useWorkspaceChangeLines } from "../use-workspace-change-lines";

export function RepositorySwitcher({ workspace, active }: { workspace: Workspace | null; active: boolean }) {
  const dispatch = useWorkspaceDispatch();
  const saved = useWorkspaceStore(state => workspace ? state.currentRepositoryByWorkspace[workspace.id] : undefined);
  if (!workspace) return null;
  const repositories = workspaceRepositories(workspace);
  if (repositories.length < 2) return null;
  const current = selectedRepository(workspace, saved);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="min-w-0 gap-1.5" aria-label={`Repository: ${current.repository}`}>
          <GithubIcon />
          <span className="max-w-40 truncate">{current.folder}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuRadioGroup value={current.repository.toLowerCase()}
          onValueChange={value => dispatch({ type: "SET_CURRENT_REPOSITORY", workspaceId: workspace.id, repository: value })}>
          {repositories.map(entry => (
            <DropdownMenuRadioItem key={entry.target} value={entry.repository.toLowerCase()} title={entry.repository}>
              <GithubIcon />
              <span className="min-w-0 flex-1 truncate">{entry.folder}</span>
              <RepositoryLines workspace={workspace} repository={entry} active={active} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <RepositoryNotes repositories={repositories} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Said once per repository whose environment files are missing, under the list. */
export function repositoryEnvironmentNote(repository: WorkspaceRepository): string | null {
  if (repository.environment === "unavailable") return `${repository.folder}: Environment files are not available for this repository in shared workspaces yet.`;
  if (repository.environment === "failed") return `${repository.folder}: Its environment files could not be added. Check them in the repository's environment settings.`;
  return null;
}

function RepositoryNotes({ repositories }: { repositories: readonly WorkspaceRepository[] }) {
  const notes = repositories.flatMap(entry => { const note = repositoryEnvironmentNote(entry); return note ? [{ key: entry.target, note }] : []; });
  if (!notes.length) return null;
  return (
    <>
      <DropdownMenuSeparator />
      {notes.map(({ key, note }) => <DropdownMenuLabel key={key} className="text-fg3 max-w-80 font-normal whitespace-normal">{note}</DropdownMenuLabel>)}
    </>
  );
}

function RepositoryLines({ workspace, repository, active }: { workspace: Workspace; repository: WorkspaceRepository; active: boolean }) {
  const lines = useWorkspaceChangeLines(repositoryWorkspace(workspace, repository), active);
  if (!lines.additions && !lines.deletions) return null;
  return (
    <span className="flex shrink-0 gap-1 text-xs tabular-nums">
      {lines.additions > 0 && <span className="text-green-text">+{lines.additions}</span>}
      {lines.deletions > 0 && <span className="text-red-text">−{lines.deletions}</span>}
    </span>
  );
}

/** A repository's GitHub URL for its pull request actions; the project's own for one repository. */
export function repositoryOriginUrl(workspace: Workspace | null, view: Workspace | null, projectOriginUrl: string | null): string | null {
  if (!workspace || !view || view === workspace) return projectOriginUrl;
  const repository = workspaceRepositories(workspace).find(entry => entry.target === view.id);
  return repository ? `https://github.com/${repository.repository}.git` : projectOriginUrl;
}
