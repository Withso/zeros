// ──────────────────────────────────────────────────────────
// discard-file — shared per-file discard (logic + confirm dialog)
// ──────────────────────────────────────────────────────────
//
// Used by BOTH the Changes-list row action and the workbench diff header, so the
// destructive discard behaves identically in both places. Tracked files revert
// to HEAD; untracked / staged-new files are deleted (they have no HEAD state).

import { useEffect } from "react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/renderer/shared/ui/primitives";
import {
  gitClean,
  gitDiscard,
  gitStatus,
  gitUnstage,
  type StatusResult,
} from "@/renderer/platform/git";

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

export type DiscardOutcome = "removed" | "reverted";
export type DiscardOperation = "clean" | "unstage-clean" | "discard";

const discardRequests = new Map<string, Promise<DiscardOutcome>>();

/** Resolve the safe git operation and the workbench path lifecycle from a live
 *  status snapshot. Kept pure so untracked, staged-new, rename, and tracked
 *  cases are regression-testable without invoking git. */
export function planDiscard(
  status: StatusResult,
  path: string,
): {
  operation: DiscardOperation;
  outcome: DiscardOutcome;
  isNewFile: boolean;
  /** A rename must restore BOTH sides: only restoring the destination can leave
   * the original path deleted in the index/worktree. */
  restorePaths?: string[];
} {
  if (status.untracked.includes(path)) {
    return { operation: "clean", outcome: "removed", isNewFile: true };
  }

  const change = [...status.staged, ...status.unstaged].find(
    (file) => file.path === path,
  );
  // A staged add (or intent-to-add reported on the unstaged side) has no HEAD
  // version. Remove its index entry before cleaning the resulting untracked
  // path. `status:"added"` here is HEAD-relative, unlike the Changes list's
  // branch-vs-base display status, so it cannot mean "added in an old commit".
  if (change?.status === "added") {
    return {
      operation: "unstage-clean",
      outcome: "removed",
      isNewFile: true,
    };
  }

  // Reverting a working-tree rename restores the old path and removes the
  // destination path currently open in workbench. It is not a destructive "new
  // file delete" for dialog wording, but its destination tab must still close.
  const renamed = change?.status === "renamed" && change.oldPath !== path;
  return {
    operation: "discard",
    outcome: renamed ? "removed" : "reverted",
    isNewFile: false,
    ...(renamed && change?.oldPath
      ? { restorePaths: [change.oldPath, path] }
      : {}),
  };
}

/** Discard one file's working-tree changes. Untracked / staged-new files are
 *  DELETED (no HEAD to revert to); tracked files are fully reverted to HEAD.
 *
 *  The file's real state is ALWAYS resolved from `git status` — never from a
 *  caller-supplied label. Critical because the "All changes" list labels every
 *  new-file-mode as "added" (the diff-vs-base parser can't tell a brand-new
 *  file from one an agent ADDED IN A COMMIT). Trusting that label routed a
 *  committed file to clean — which only removes untracked files → a silent
 *  no-op. Self-resolving keeps the Changes-list and workbench Discard buttons
 *  behaving identically and correctly. */
async function performDiscard(
  workspaceId: string,
  path: string,
  expectedNew?: boolean,
): Promise<DiscardOutcome> {
  const status = await gitStatus(workspaceId, {
    paths: [path],
    includeTracking: false,
  });
  const plan = planDiscard(status, path);
  if (expectedNew !== undefined && plan.isNewFile !== expectedNew) {
    throw new Error(
      `${baseName(path)} changed since the confirmation opened; review its current Changes state and try again`,
    );
  }
  switch (plan.operation) {
    case "clean":
      await gitClean({ workspaceId, paths: [path] });
      break;
    case "unstage-clean":
      await gitUnstage({ workspaceId, paths: [path] });
      await gitClean({ workspaceId, paths: [path] });
      break;
    case "discard":
      await gitDiscard({
        workspaceId,
        paths: plan.restorePaths ?? [path],
      });
      break;
  }
  return plan.outcome;
}

export function discardPath(
  workspaceId: string,
  path: string,
  options: { expectedNew?: boolean } = {},
): Promise<DiscardOutcome> {
  const key = JSON.stringify([workspaceId, path, options.expectedNew]);
  const pending = discardRequests.get(key);
  if (pending) return pending;

  const request = performDiscard(
    workspaceId,
    path,
    options.expectedNew,
  ).finally(() => {
    if (discardRequests.get(key) === request) discardRequests.delete(key);
  });
  discardRequests.set(key, request);
  return request;
}

/** Confirm before a destructive discard. ⌘/Ctrl+↵ confirms; default focus is
 *  Cancel so a stray Enter can't discard. */
export function DiscardDialog({
  path,
  isNew,
  onCancel,
  onConfirm,
}: {
  path: string;
  /** Untracked / staged-new → "delete" wording (irreversible, no HEAD). */
  isNew: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const name = baseName(path);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm]);
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "Delete untracked file?" : "Discard file changes?"}
          </DialogTitle>
          <DialogDescription>
            {isNew ? (
              <>
                Delete{" "}
                <code className="bg-bg2-hover text-fg1 rounded-sm px-1 py-0.5 font-mono">
                  {name}
                </code>
                ? It isn’t tracked by Git, so this can’t be undone.
              </>
            ) : (
              <>
                Discard all changes to{" "}
                <code className="bg-bg2-hover text-fg1 rounded-sm px-1 py-0.5 font-mono">
                  {name}
                </code>
                ? This action cannot be undone.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-2 gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {isNew ? "Delete file" : "Discard"}
            <span className="text-xxs ml-1 opacity-70">⌘↵</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
