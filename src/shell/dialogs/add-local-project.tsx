// ──────────────────────────────────────────────────────────
// Add local project dialog — Phase 1A modal (Roadmap 03a)
// ──────────────────────────────────────────────────────────
//
// Triggered when the user picks a folder via "Open project" and the
// folder turns out to be a *linked* worktree owned by another tool
// (Cursor / Superset / workmux and friends). Layout:
//
//   ┌──────────────────────────────────────────────────────┐
//   │ Add local project                                    │
//   │ New workspace start from `sacramento` ▸ acme/example │
//   │                              [Cancel]  [Add project] │
//   └──────────────────────────────────────────────────────┘
//
// On confirm we register the folder's *repo root* (the common gitdir's
// directory) as a Zeros project, and adopt the foreign branch as a
// Zeros workspace via workspace_create_from_branch.

import React, { useMemo, useState } from "react";
import { GitBranch } from "lucide-react";

import { Button } from "../../zeros/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../zeros/ui/primitives/dialog";
import { toast } from "../../zeros/ui/primitives/elements";

import {
  isGitErrorShape,
  workspaceAdoptExisting,
  type DetectedTool,
  type InspectFolderResult,
} from "../../native/git";
import {
  notifyProjectsChanged,
  notifyWorkspacesChanged,
} from "../../zeros/store/use-projects";
import {
  repoSlugFromOriginUrl,
  upsertProject,
} from "../../zeros/store/projects-store";
import { recordAdoptedWorktree } from "../../zeros/store/adopted-worktrees";
import { ZerosSpinner } from "@/loaders";

// Display names for the tool that created a worktree Zeros is adopting. These
// are interop labels, not endorsements: `DetectedTool` (src/engine/git/types.ts)
// is persisted on workspace rows, and telling someone which tool made a
// worktree is the entire point of the adoption dialog.
const ORIGIN_LABELS: Record<DetectedTool, string> = {
  zeros: "Zeros",
  cursor: "Cursor",
  conductor: "Conductor", // check-secrets:allow-identity — interop label, not prose
  superset: "Superset",
  workmux: "Workmux",
  unknown: "External",
};

interface AddLocalProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The folder the user picked. Inspection happens upstream; we just
   *  consume the result. */
  inspect: (InspectFolderResult & { path: string }) | null;
  onAdded?: (args: { repoRoot: string; workspacePath: string }) => void;
}

/** Derive a short owner/repo label from an origin URL. Falls back to
 *  the repo slug when we can't parse it. */
function ownerRepoLabel(originUrl: string | null): string {
  if (!originUrl) return "";
  const sshMatch = originUrl.match(/^[^@]+@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1].replace(/\.git$/i, "");
  const httpMatch = originUrl.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (httpMatch) return httpMatch[1].replace(/\.git$/i, "");
  return "";
}

export function AddLocalProjectDialog({
  open,
  onOpenChange,
  inspect,
  onAdded,
}: AddLocalProjectDialogProps) {
  const [busy, setBusy] = useState(false);

  const ownerRepo = useMemo(
    () => ownerRepoLabel(inspect?.originUrl ?? null),
    [inspect?.originUrl],
  );

  const handleAdd = async () => {
    if (!inspect || busy) return;
    if (!inspect.branch) {
      toast.error("Couldn't read the branch from this worktree.", {
        description: "Detached HEAD? Check out a branch first.",
      });
      return;
    }
    setBusy(true);
    try {
      // Register the PRIMARY checkout as the project (so Local main is the real
      // trunk), NOT the picked worktree. The engine resolved it via
      // git-common-dir; fall back to the picked path only if that failed
      // (e.g. an offline repo the engine couldn't probe).
      const projectRoot = inspect.mainRoot ?? inspect.path;
      const slug = inspect.originUrl
        ? repoSlugFromOriginUrl(inspect.originUrl)
        : "";
      // `ownerRepo` is "" for a no-origin repo, and "".split("/").pop() is ""
      // (not undefined) — so `?? projectRoot` never fired and the project
      // landed with a BLANK name. Pass undefined when empty so upsertProject
      // derives the name from the path (deriveProjectName → e.g. "r2").
      const projectName = ownerRepo.split("/").pop() || undefined;
      const project = upsertProject({
        repoRoot: projectRoot,
        repoSlug: slug || undefined,
        originUrl: inspect.originUrl,
        name: projectName,
      });
      notifyProjectsChanged();
      // Adopt the picked worktree IN PLACE as a workspace of that project — no
      // `git worktree add`; the worktree already exists on disk. Pass the
      // project's FINAL slug (path-derived when there's no origin) so the
      // workspace always shares it and shows under the project.
      const created = await workspaceAdoptExisting({
        repoRoot: projectRoot,
        worktreePath: inspect.path,
        branchName: inspect.branch,
        repoSlug: project.repoSlug,
        sourceTool: inspect.sourceTool,
      });
      // Teach the renderer's path→project resolver about this external path —
      // its regex only matches Zeros-managed worktree roots.
      recordAdoptedWorktree(inspect.path, project.repoSlug);
      notifyWorkspacesChanged();
      onAdded?.({ repoRoot: projectRoot, workspacePath: created.path });
      onOpenChange(false);
    } catch (err: unknown) {
      if (isGitErrorShape(err)) {
        toast.error(`Couldn't add this project: ${err.message}`, {
          description: err.remediation ?? undefined,
        });
      } else {
        toast.error(
          `Couldn't add this project: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  if (!inspect) return null;

  const branchLabel = inspect.branch ?? "(detached HEAD)";
  const toolLabel = ORIGIN_LABELS[inspect.sourceTool];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px] gap-4">
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="text-sm font-medium">Add local project</DialogTitle>
          <DialogDescription className="text-sm text-fg2">
            This folder is a worktree managed by{" "}
            <span className="text-fg1 font-medium">{toolLabel}</span>. Zeros
            will add its repository and adopt this worktree as a workspace —
            the worktree stays exactly where it is.
          </DialogDescription>
        </div>

        <div className="rounded-md border border-border1 bg-bg2 px-3 py-2.5 flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <GitBranch className="size-3.5 text-fg2 shrink-0" />
            <span className="text-sm text-fg1 truncate">
              {branchLabel}
            </span>
          </div>
          {ownerRepo && (
            <div className="text-xs text-fg2 pl-5.5">
              {ownerRepo}
            </div>
          )}
          <div className="text-xs text-fg2 truncate pl-5.5">
            {inspect.path}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleAdd}
            disabled={busy}
          >
            {busy && <ZerosSpinner size={16} tone="inverted" />}
            Add project
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
