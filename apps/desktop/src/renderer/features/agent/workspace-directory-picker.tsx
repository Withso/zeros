// ──────────────────────────────────────────────────────────
// WorkspaceDirectoryPicker — link extra directories for `/add-dir`
// ──────────────────────────────────────────────────────────
//
// A command-palette modal for granting a Claude chat access to directories
// beyond its own cwd (SDK `additionalDirectories`). Two ways in: the `/add-dir`
// slash command and the composer "+" → "Link workspaces" menu.
//
// Layout (per the 2026-06-08 mockup):
//   Directories
//     Browse…                         → native folder dialog (any folder)
//     <linked browsed folder>  ✓ Unlink
//   <repo name>
//     <branch>            <worktree name>   ✓   (click toggles link)
//
// Active worktrees come from `workspaceList()` (every repo), grouped by repo.
// A worktree row links its `path`; a linked worktree shows a ✓ and toggles off.
// Linked dirs that are NOT worktrees (a Browse… pick) live in "Directories"
// with an explicit Unlink. The dialog is multi-select — it stays open so the
// user can link/unlink several, then dismisses it (Esc / overlay / ✕).
// ──────────────────────────────────────────────────────────

import { useCallback, useMemo } from "react";
import { Check, Folder, FolderSearch } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../shared/ui/primitives/command";
import { branchDisplayName } from "../../shared/lib/branch-name";
import { cn } from "../../shared/ui/cn";
import { dialogPickFolder, workspaceList, type Workspace } from "../../platform/git";
import { useProjects } from "../../state/use-projects";
import {
  GIT_READ_MAX_AGE_MS,
  pickerWorkspacesCache,
} from "../../state/read-caches";
import { useCachedRead } from "../../state/use-cached-read";

const NO_WORKSPACES: Workspace[] = [];

export interface WorkspaceDirectoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Currently-linked dirs (ChatThread.additionalDirectories). */
  linkedDirs: string[];
  /** The chat's own cwd — excluded from the list (already accessible). */
  cwd: string;
  /** Grant access to a directory (worktree path or a Browse… pick). */
  onLink: (dir: string) => void;
  /** Revoke access to a directory. */
  onUnlink: (dir: string) => void;
}

/** Last path segment, for a worktree's display name + a linked dir's label. */
function baseName(p: string): string {
  const parts = p.split(/[/\\]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

/** A worktree's primary label: its branch with the workspace prefix stripped
 *  (matches the sidebar's WorkspaceRow). Shared branchDisplayName rather than a
 *  private `zeros/` literal — Settings → Git made the prefix a choice, and an
 *  inlined strip left `jordan/Cream` labelled with its whole ref here while
 *  every other surface showed `Cream`. */
const branchLabel = branchDisplayName;

export function WorkspaceDirectoryPicker({
  open,
  onOpenChange,
  linkedDirs,
  cwd,
  onLink,
  onUnlink,
}: WorkspaceDirectoryPickerProps) {
  const { projects } = useProjects();

  // Cached worktree list ("*" = every repo): reopening paints the previous
  // rows instantly, and a background revalidation runs only when the entry is
  // stale (workspace create/archive invalidates it via
  // notifyWorkspacesChanged). Returns [] off-desktop — the dialog still offers
  // Browse… (also desktop-only) + any already-linked dirs.
  const workspacesRead = useCachedRead(
    pickerWorkspacesCache,
    open ? "*" : null,
    () => workspaceList(),
    { maxAgeMs: GIT_READ_MAX_AGE_MS },
  );
  const workspaces = workspacesRead.data ?? NO_WORKSPACES;

  const linkedSet = useMemo(() => new Set(linkedDirs), [linkedDirs]);

  // repoSlug → human project name, for group headings.
  const projectName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.repoSlug, p.name);
    return m;
  }, [projects]);

  // Present worktrees only, never the chat's own cwd (already accessible),
  // grouped by repo. Each group sorted by branch for a stable order.
  const groups = useMemo(() => {
    const byRepo = new Map<string, Workspace[]>();
    for (const ws of workspaces) {
      if (ws.present === false) continue;
      if (ws.path === cwd) continue;
      const list = byRepo.get(ws.repoSlug) ?? [];
      list.push(ws);
      byRepo.set(ws.repoSlug, list);
    }
    return Array.from(byRepo.entries())
      .map(([slug, list]) => ({
        slug,
        heading: projectName.get(slug) ?? slug,
        workspaces: list.sort((a, b) => a.branch.localeCompare(b.branch)),
      }))
      .sort((a, b) => a.heading.localeCompare(b.heading));
  }, [workspaces, cwd, projectName]);

  // Linked dirs that are NOT one of the active worktrees → shown in
  // "Directories" with an explicit Unlink (linked worktrees show a ✓ inline).
  const linkedBrowsedDirs = useMemo(() => {
    const worktreePaths = new Set(workspaces.map((w) => w.path));
    return linkedDirs.filter((d) => !worktreePaths.has(d));
  }, [linkedDirs, workspaces]);

  const handleBrowse = useCallback(async () => {
    const picked = await dialogPickFolder({
      title: "Give Claude access to a directory",
      defaultPath: cwd || undefined,
    });
    if (picked) onLink(picked);
  }, [cwd, onLink]);

  const toggle = useCallback(
    (dir: string) => {
      if (linkedSet.has(dir)) onUnlink(dir);
      else onLink(dir);
    },
    [linkedSet, onLink, onUnlink],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Link a workspace or directory"
      description="Give this chat access to another worktree or a folder."
      className="sm:max-w-[560px]"
    >
      <CommandInput placeholder="Search workspaces…" />
      <CommandList className="max-h-[380px]">
        <CommandEmpty>No workspaces found.</CommandEmpty>

        <CommandGroup heading="Directories">
          {/* Broad value so the row survives most searches — it's the escape
              hatch when no worktree matches. */}
          <CommandItem
            value="browse open finder folder directory add"
            onSelect={() => void handleBrowse()}
            className="gap-2"
          >
            <FolderSearch size={16} className="shrink-0 text-fg2" />
            <span className="text-fg1">Browse…</span>
          </CommandItem>
          {linkedBrowsedDirs.map((dir) => (
            <CommandItem
              key={dir}
              value={`${baseName(dir)} ${dir}`}
              onSelect={() => onUnlink(dir)}
              className="gap-2"
            >
              <Folder size={16} className="shrink-0 text-fg2" />
              <span className="max-w-[160px] shrink-0 truncate text-fg1">
                {baseName(dir)}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-fg2">
                {dir}
              </span>
              <Check size={14} className="shrink-0 text-fg1" />
              <span className="shrink-0 text-xs text-fg2">Unlink</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {groups.map((g) => (
          <CommandGroup key={g.slug} heading={g.heading}>
            {g.workspaces.map((ws) => {
              const linked = linkedSet.has(ws.path);
              return (
                <CommandItem
                  key={ws.id}
                  value={`${branchLabel(ws.branch)} ${baseName(ws.path)} ${ws.path}`}
                  onSelect={() => toggle(ws.path)}
                  className="gap-2"
                >
                  <Folder size={16} className="shrink-0 text-fg2" />
                  <span className="min-w-0 flex-1 truncate text-fg1">
                    {branchLabel(ws.branch)}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-xs text-fg2",
                      linked && "mr-1",
                    )}
                  >
                    {baseName(ws.path)}
                  </span>
                  {linked && (
                    <Check size={14} className="shrink-0 text-fg1" />
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
