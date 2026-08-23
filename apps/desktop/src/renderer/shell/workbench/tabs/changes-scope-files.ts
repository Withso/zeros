import type { StatusResult } from "@/renderer/platform/git";

import { parseUnifiedDiffFiles, type ChangedFile } from "./changes-parse";

/** Tracked rows for one live scope. The comparison patch is authoritative;
 * porcelain only adds index/new-file/rename metadata. This prevents an AD path
 * from leaking into the net Uncommitted list while retaining it in Staged and
 * Unstaged, whose patches genuinely contain it. */
export function trackedFilesForScope(
  patchOrFiles: string | ChangedFile[],
  status: Pick<StatusResult, "staged" | "unstaged" | "conflicted">,
): ChangedFile[] {
  const conflictedPaths = new Set(status.conflicted.map((file) => file.path));
  const stagedPaths = new Set(status.staged.map((file) => file.path));
  const newPaths = new Set(
    [...status.staged, ...status.unstaged]
      .filter((file) => file.status === "added")
      .map((file) => file.path),
  );
  const statusByPath = new Map(
    [...status.unstaged, ...status.staged].map((file) => [file.path, file]),
  );
  const files =
    typeof patchOrFiles === "string"
      ? parseUnifiedDiffFiles(patchOrFiles)
      : patchOrFiles;
  return files
    .filter((file) => !conflictedPaths.has(file.path))
    .map((file) => ({
      ...file,
      oldPath: file.oldPath ?? statusByPath.get(file.path)?.oldPath,
      staged: stagedPaths.has(file.path),
      isNewFile: newPaths.has(file.path),
    }));
}
