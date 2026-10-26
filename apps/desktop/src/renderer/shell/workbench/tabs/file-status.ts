import type { FileChangeStatus, StatusResult } from "@/renderer/platform/git";
import { relativeWorkspaceFilePath } from "@/renderer/platform/workspace-file-path";

export const FILE_STATUS_PRESENTATION = {
  added: { letter: "A", label: "Added", className: "text-green-primary" },
  modified: {
    letter: "M",
    label: "Modified",
    className: "text-yellow-primary",
  },
  deleted: { letter: "D", label: "Deleted", className: "text-red-primary" },
  renamed: { letter: "R", label: "Renamed", className: "text-blue-primary" },
  untracked: {
    letter: "U",
    label: "Untracked",
    className: "text-green-primary",
  },
  conflicted: { letter: "!", label: "Unmerged", className: "text-red-primary" },
} as const satisfies Record<
  FileChangeStatus,
  { letter: string; label: string; className: string }
>;

export const EMPTY_FILE_STATUSES: ReadonlyMap<string, FileChangeStatus> =
  new Map();

/** Porcelain enriches Files labels only. Changes rows/counts still use their
 * independent net comparisons. Working-tree deletion wins over a staged add;
 * further edits preserve an added/renamed path's lifecycle identity. */
export function fileStatusesForFolder(
  status: StatusResult | undefined,
  cwd: string | undefined,
  gitRoot: string | undefined,
): ReadonlyMap<string, FileChangeStatus> {
  if (!status || !cwd || !gitRoot) return EMPTY_FILE_STATUSES;
  const result = new Map<string, FileChangeStatus>();
  const relative = (path: string) =>
    relativeWorkspaceFilePath(cwd, `${gitRoot.replace(/\/+$/, "")}/${path}`);
  for (const file of [...status.staged, ...status.unstaged]) {
    if (file.oldPath) {
      const old = relative(file.oldPath);
      if (old && !result.has(old)) result.set(old, "deleted");
    }
    const path = relative(file.path);
    if (!path) continue;
    const existing = result.get(path);
    if (
      file.status === "modified" &&
      (existing === "added" || existing === "renamed")
    )
      continue;
    result.set(path, file.status);
  }
  for (const entry of status.untracked) {
    const path = relative(entry);
    if (path) result.set(path, "untracked");
  }
  for (const file of status.conflicted) {
    const path = relative(file.path);
    if (path) result.set(path, "conflicted");
  }
  return result.size ? result : EMPTY_FILE_STATUSES;
}
