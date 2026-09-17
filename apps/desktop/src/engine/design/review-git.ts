import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type {
  DesignReviewScope,
  DesignReviewSnapshot,
  DesignReviewFileDetail,
  DesignReviewFile,
} from "@zeros/protocol/design-review";
import { diff, status, type DiffMode } from "../git/diff";
import { gitIndexFingerprint } from "../git/index-fingerprint";
import { designDirectoryNameFor } from "./document";
import { designDirectoryEntry, designMetadataGitPaths } from "./metadata";
import { DesignRequestStore } from "./request-store";
import { assertDesignReviewDirectory, designReviewProposal } from "./review";
import { readSafeRegularFile } from "./safe-files";

const modes: Record<Exclude<DesignReviewScope, "proposals">, DiffMode> = {
  all: "worktree-vs-base",
  uncommitted: "worktree-vs-head",
  staged: "index-vs-head",
  unstaged: "worktree-vs-index",
};
const PATCH_BYTES = 512 * 1024;
function pathsForReview(root: string, directory: string): string[] {
  return [...new Set([directory, ...designMetadataGitPaths(root, directory)])];
}
function contains(paths: string[], file: string): boolean {
  return (
    !file.includes("\\") &&
    !path.posix.isAbsolute(file) &&
    path.posix.normalize(file) === file &&
    paths.some((root) => file === root || file.startsWith(`${root}/`))
  );
}

export async function readDesignReviewSnapshot(
  workspaceId: string,
  root: string,
  input: { scope: DesignReviewScope; offset: number; limit: number },
): Promise<DesignReviewSnapshot> {
  const directory = designDirectoryNameFor(root);
  const directoryId = designDirectoryEntry(root, directory)?.id;
  if (!directoryId)
    throw new Error(
      "Reopen Design to upgrade this folder before reviewing changes.",
    );
  const paths = pathsForReview(root, directory);
  const fingerprint = await gitIndexFingerprint(root);
  const [gitStatus, records, ...comparisons] = await Promise.all([
    status(workspaceId, { paths, includeTracking: false }),
    new DesignRequestStore(root, directoryId).read(),
    ...Object.values(modes).map((mode) =>
      diff({
        workspaceId,
        mode,
        filePaths: paths.map((file) => `:(literal)${file}`),
        summaryLimit: 0,
        maxMetadataBytes: 1024 * 1024,
      }),
    ),
  ]);
  if (fingerprint !== (await gitIndexFingerprint(root)))
    throw new Error("Staging changed while review loaded. Refresh review.");
  const proposals = records
    .filter(
      (record) =>
        record.proposal ||
        record.transaction ||
        record.status === "indeterminate" ||
        record.status === "started",
    )
    .map(designReviewProposal)
    .sort((a, b) => b.createdAt - a.createdAt);
  const filesByScope = Object.fromEntries(
    Object.keys(modes).map((scope, index) => {
      const files: DesignReviewFile[] = comparisons[index]!.files ?? [];
      const seen = new Set(files.map((file) => file.path));
      if (scope !== "staged") {
        for (const file of gitStatus.untracked) {
          if (!seen.has(file) && contains(paths, file))
            files.push({
              path: file,
              status: "added",
              additions: 0,
              deletions: 0,
              binary: false,
            });
        }
      }
      for (const file of gitStatus.conflicted) {
        if (!seen.has(file.path))
          files.push({ ...file, additions: 0, deletions: 0, binary: false });
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      return [scope, files];
    }),
  ) as Record<Exclude<DesignReviewScope, "proposals">, DesignReviewFile[]>;
  const counts = {
    all: filesByScope.all.length,
    uncommitted: filesByScope.uncommitted.length,
    staged: filesByScope.staged.length,
    unstaged: filesByScope.unstaged.length,
    proposals: proposals.length,
  };
  const total = counts[input.scope];
  return {
    directory,
    directoryId,
    indexFingerprint: fingerprint,
    scope: input.scope,
    counts,
    conflict:
      gitStatus.conflictState !== null || gitStatus.conflicted.length > 0,
    files:
      input.scope === "proposals"
        ? []
        : filesByScope[input.scope].slice(
            input.offset,
            input.offset + input.limit,
          ),
    proposals:
      input.scope === "proposals"
        ? proposals.slice(input.offset, input.offset + input.limit)
        : [],
    nextOffset:
      input.offset + input.limit < total ? input.offset + input.limit : null,
  };
}

export async function readDesignReviewFile(
  workspaceId: string,
  root: string,
  input: {
    directoryId: string;
    scope: Exclude<DesignReviewScope, "proposals">;
    path: string;
    oldPath?: string;
  },
): Promise<DesignReviewFileDetail> {
  const directory = assertDesignReviewDirectory(root, input.directoryId);
  const paths = pathsForReview(root, directory);
  if (
    !contains(paths, input.path) ||
    (input.oldPath !== undefined && !contains(paths, input.oldPath))
  )
    throw new Error("The selected file is outside this Design folder.");
  const detail = {
    path: input.path,
    patch: "",
    binary: false,
    truncated: false,
  };
  const comparison = await diff({
    workspaceId,
    filePath: input.path,
    oldFilePath: input.oldPath,
    mode: modes[input.scope],
    rawPatch: true,
    summaryLimit: 1,
    maxPatchBytes: PATCH_BYTES,
    maxMetadataBytes: 1024 * 1024,
  });
  if (comparison.summary)
    return {
      ...detail,
      truncated: true,
      binary: comparison.files?.[0]?.binary ?? false,
    };
  if (comparison.patch)
    return {
      ...detail,
      patch: comparison.patch,
      binary: comparison.patch.includes("Binary files "),
    };
  if (input.scope === "staged") return detail;
  const current = await status(workspaceId, {
    paths: [input.path],
    includeTracking: false,
  });
  if (!current.untracked.includes(input.path)) return detail;
  const source = await readSafeRegularFile(
    root,
    path.join(root, input.path),
    PATCH_BYTES / 2,
  );
  if (!source) return { ...detail, truncated: true };
  if (source.body.includes(0)) return { ...detail, binary: true };
  const patch = createTwoFilesPatch(
    "/dev/null",
    input.path,
    "",
    source.body.toString("utf8"),
    "",
    "",
    { context: 3, timeout: 250 },
  );
  return patch && Buffer.byteLength(patch) <= PATCH_BYTES
    ? { ...detail, patch }
    : { ...detail, truncated: true };
}
