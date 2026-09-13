import {
  parseDiffFromFile,
  parsePatchFiles,
  type FileDiffLoadedFiles,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { KeyedAsyncCache } from "@/renderer/shared/lib/keyed-async-cache";
import {
  loadWorkspaceFileDiff,
  loadWorkspaceFileRead,
  workspaceFileDiffKey,
  type WorkspaceFileDiffQuery,
} from "../../workspace-file-data-cache";
import type { ChangedFile } from "./changes-parse";
import { hashString } from "./use-viewed-files";

export interface ChangesDiffData {
  fileDiff?: FileDiffMetadata;
  loadedFiles?: FileDiffLoadedFiles;
  message?: string;
  notice?: string;
  copyText?: string;
}

const MAX_COMPLETE_PATCH_CHARS = 8 * 1024 * 1024;

/** Only the explicitly complete Git response may be used to reconstruct file
 * contents. Ordinary -U3 patches are partial and cannot expand hidden context. */
export function completeChangesDiff(
  patch: string,
  path: string,
  renderDiff = false,
): ChangesDiffData {
  if (!patch) return { message: "No textual changes" };
  if (patch.length > MAX_COMPLETE_PATCH_CHARS) {
    return {
      notice: "Unchanged lines are unavailable for this large file.",
      ...(renderDiff ? { message: "This file is too large to display." } : {}),
    };
  }
  const files = parsePatchFiles(patch, undefined, true).flatMap((p) => p.files);
  const parsed = files.find(
    (file) => file.name === path || file.prevName === path,
  );
  if (!parsed) return { message: "No textual diff available for this file" };
  if (/(?:^|\n)(?:GIT binary patch|Binary files .+ differ)(?:\n|$)/.test(patch))
    return { message: "Binary file changed" };
  if (!parsed.hunks.length) return { message: "File metadata changed" };
  const before = parsed.deletionLines.join("");
  const after = parsed.additionLines.join("");
  const snapshotKey = hashString(patch);
  // Pierre owns the hydration and hunk expansion. The complete Git response
  // supplies exact before/after contents only when its `loadDiffFiles` hook is
  // invoked; ordinary list rendering keeps using the compact patch metadata.
  const oldFile = {
    name: parsed.prevName ?? path,
    contents: before,
    cacheKey: `${snapshotKey}:old`,
  };
  const newFile = {
    name: parsed.name,
    contents: after,
    cacheKey: `${snapshotKey}:new`,
  };
  const loadedFiles =
    parsed.type === "change" || parsed.type === "rename-changed"
      ? { oldFile, newFile }
      : undefined;
  return {
    // Summary/legacy turn rows have no partial diff to hydrate. Build their
    // first render from the complete snapshots, with native collapsed context.
    ...(renderDiff
      ? {
          fileDiff: parseDiffFromFile(
            parsed.type === "new" ? null : oldFile,
            parsed.type === "deleted" ? null : newFile,
            { context: 3 },
          ),
        }
      : {}),
    ...(loadedFiles ? { loadedFiles } : {}),
    copyText: parsed.type === "deleted" ? before : after,
  };
}

export function initialChangesDiff(file: ChangedFile): ChangesDiffData {
  if (file.binary) return { message: "Binary file changed" };
  if (!file.patch) return { message: "Loading diff…" };
  try {
    const parsed = parsePatchFiles(file.patch, undefined, true)
      .flatMap((p) => p.files)
      .find((diff) => diff.name === file.path || diff.prevName === file.path);
    if (!parsed) return { message: "Unable to parse this diff" };
    if (!parsed.hunks.length) return { message: "File metadata changed" };
    return {
      fileDiff: parsed,
      ...(parsed.type === "new"
        ? { copyText: parsed.additionLines.join("") }
        : parsed.type === "deleted"
          ? { copyText: parsed.deletionLines.join("") }
          : {}),
    };
  } catch {
    return { message: "Unable to parse this diff" };
  }
}

export function changesDiffDataWeight(value: ChangesDiffData): number {
  let lines = 0;
  for (const line of value.fileDiff?.deletionLines ?? []) lines += line.length;
  for (const line of value.fileDiff?.additionLines ?? []) lines += line.length;
  lines += value.loadedFiles?.oldFile?.contents.length ?? 0;
  lines += value.loadedFiles?.newFile.contents.length ?? 0;
  return Math.max(
    1,
    2 * (lines + (value.copyText?.length ?? 0) + (value.message?.length ?? 0)),
  );
}

/** Metadata-only patches (pure rename, mode change) contain no hunk text, so
 * their copy action uses the current source without changing the diff card. */
export function withChangesDiffCopyText(
  value: ChangesDiffData,
  copyText: string,
): ChangesDiffData {
  return value.copyText === undefined ? { ...value, copyText } : value;
}

const cache = new KeyedAsyncCache<ChangesDiffData>({
  maxEntries: 96,
  maxWeight: 32 * 1024 * 1024,
  weightOf: changesDiffDataWeight,
});
let inFlight = 0;
const queue: Array<() => void> = [];
async function bounded<T>(run: () => Promise<T>): Promise<T> {
  if (inFlight >= 4) await new Promise<void>((resolve) => queue.push(resolve));
  else inFlight++;
  try {
    return await run();
  } finally {
    const next = queue.shift();
    if (next) next();
    else inFlight--;
  }
}

export function changesDiffDataKey(
  query: WorkspaceFileDiffQuery,
  file: ChangedFile,
  refreshKey: number,
): string {
  return JSON.stringify([
    workspaceFileDiffKey(query),
    file.hash ?? hashString(file.patch),
    file.status,
    refreshKey,
  ]);
}

export function peekChangesDiffData(key: string): ChangesDiffData | undefined {
  return cache.peekSnapshot(key).data;
}

export function loadChangesDiffData(
  key: string,
  query: WorkspaceFileDiffQuery,
  file: ChangedFile,
  cwd: string,
): Promise<ChangesDiffData> {
  return cache.load(
    key,
    () =>
      bounded(async () => {
        if (file.binary) return { message: "Binary file changed" };
        const patch = await loadWorkspaceFileDiff(
          { ...query, fullContext: true },
          { maxAgeMs: 15_000 },
        );
        if (patch) {
          const complete = completeChangesDiff(patch, file.path, !file.patch);
          if (
            complete.message === "File metadata changed" &&
            file.status !== "deleted"
          ) {
            const result = await loadWorkspaceFileRead(
              { cwd, path: file.path },
              { maxAgeMs: 15_000 },
            );
            if (result.kind === "text")
              return withChangesDiffCopyText(complete, result.content ?? "");
          }
          return complete;
        }
        if (file.status === "untracked" || file.isNewFile) {
          const result = await loadWorkspaceFileRead(
            { cwd, path: file.path },
            { maxAgeMs: 15_000 },
          );
          if (result.kind === "text") {
            if (!result.content) return { message: "Empty file", copyText: "" };
            return {
              fileDiff: {
                ...parseDiffFromFile(
                  { name: file.path, contents: "" },
                  { name: file.path, contents: result.content },
                ),
                type: "new",
              },
              copyText: result.content,
            };
          }
          if (result.kind === "error")
            throw new Error(result.error ?? "Unable to read this file");
          return { message: "Binary file changed" };
        }
        return { message: "No textual changes" };
      }),
    { maxAgeMs: 15_000 },
  );
}

export function resetChangesDiffDataForTests(): void {
  cache.clear();
  inFlight = 0;
  queue.length = 0;
}
