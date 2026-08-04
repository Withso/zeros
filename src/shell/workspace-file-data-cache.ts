// ──────────────────────────────────────────────────────────
// Workspace file data cache — content + per-file diff snapshots
// ──────────────────────────────────────────────────────────
//
// File navigation is a query transition, not component-local state. A viewer
// may unmount when its row-1 tab or workspace is parked, while the exact
// content/diff it resolved remains useful. These bounded caches make that
// resolved snapshot available during the destination's first render and
// revalidate it in the background.
//
// Changes already downloads a whole-worktree patch to build its file list. It
// primes the per-file diff cache from that response, avoiding a second git
// process on row click. Hover/intent prefetch primes file content before the
// corresponding viewer becomes visible.
//
// Reading a file for display also warms its SYNTAX grammar (prewarmFileSyntax),
// so the grammar import races the read instead of following it — that is what
// lets the viewer's editor paint its first frame already in the code theme
// instead of flashing chrome-colored text.
// ──────────────────────────────────────────────────────────

import { useCallback, useSyncExternalStore } from "react";

import { gitDiff } from "@/native/git";
import { readWorkspaceFile, type ReadFileResult } from "@/native/files";
import { turnDiff } from "@/native/turns";
import {
  KeyedAsyncCache,
  type AsyncCacheSnapshot,
} from "@/zeros/lib/keyed-async-cache";
import { prewarmFileSyntax } from "./column3-tabs/code-editor/prewarm-file-syntax";

export interface WorkspaceFileReadQuery {
  cwd: string;
  path: string;
  /** Destructive resets get their own snapshot so an old editor value can
   * never seed the replacement editor before the authoritative read lands. */
  contentRevision?: number;
}

export interface WorkspaceFileDiffQuery {
  workspaceId: string;
  path: string;
  diffScope?: "all" | "uncommitted" | "staged" | "unstaged" | "commit" | "turn";
  diffSha?: string;
  turnChatId?: string;
  turnId?: string;
}

const fileReadCache = new KeyedAsyncCache<ReadFileResult>(96);
const fileDiffCache = new KeyedAsyncCache<string>(160);

function normalizeCwd(cwd: string): string {
  if (cwd === "/" || /^[A-Za-z]:[\\/]$/.test(cwd)) return cwd;
  return cwd.replace(/[\\/]+$/, "");
}

export function workspaceFileReadKey(query: WorkspaceFileReadQuery): string {
  return JSON.stringify([
    normalizeCwd(query.cwd),
    query.path,
    query.contentRevision ?? 0,
  ]);
}

export function workspaceFileDiffKey(query: WorkspaceFileDiffQuery): string {
  return JSON.stringify([
    query.workspaceId,
    query.path,
    query.diffScope ?? "all",
    query.diffSha ?? "",
    query.turnChatId ?? "",
    query.turnId ?? "",
  ]);
}

async function fetchWorkspaceFileRead(
  query: WorkspaceFileReadQuery,
): Promise<ReadFileResult> {
  const result = await readWorkspaceFile(query.cwd, query.path);
  if (!result) throw new Error("Workspace file reader unavailable");
  return result;
}

async function fetchWorkspaceFileDiff(
  query: WorkspaceFileDiffQuery,
): Promise<string> {
  const isTurn =
    query.diffScope === "turn" && !!query.turnChatId && !!query.turnId;
  if (isTurn) {
    return (
      (await turnDiff({
        chatId: query.turnChatId!,
        turnId: query.turnId!,
        path: query.path,
      })) ?? ""
    );
  }
  const isCommit = query.diffScope === "commit" && !!query.diffSha;
  const mode =
    query.diffScope === "uncommitted"
      ? "worktree-vs-head"
      : query.diffScope === "staged"
        ? "index-vs-head"
        : query.diffScope === "unstaged"
          ? "worktree-vs-index"
          : isCommit
            ? "refs"
            : "worktree-vs-base";
  const result = await gitDiff({
    workspaceId: query.workspaceId,
    filePath: query.path,
    mode,
    ...(isCommit ? { base: `${query.diffSha}~1`, head: query.diffSha } : {}),
    rawPatch: true,
  });
  return result.patch ?? "";
}

function useSnapshot<T>(
  cache: KeyedAsyncCache<T>,
  key: string,
): AsyncCacheSnapshot<T> {
  const subscribe = useCallback(
    (listener: () => void) => cache.subscribe(key, listener),
    [cache, key],
  );
  const getSnapshot = useCallback(() => cache.getSnapshot(key), [cache, key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useWorkspaceFileReadSnapshot(
  query: WorkspaceFileReadQuery,
): AsyncCacheSnapshot<ReadFileResult> {
  return useSnapshot(fileReadCache, workspaceFileReadKey(query));
}

export function useWorkspaceFileDiffSnapshot(
  query: WorkspaceFileDiffQuery,
): AsyncCacheSnapshot<string> {
  return useSnapshot(fileDiffCache, workspaceFileDiffKey(query));
}

export function loadWorkspaceFileRead(
  query: WorkspaceFileReadQuery,
  options: { force?: boolean; maxAgeMs?: number } = {},
): Promise<ReadFileResult> {
  // Every read is a file about to be shown: start its grammar import now so it
  // finishes with (not after) the read. Deduplicated, so the revalidation calls
  // on a git refresh cost a map lookup.
  prewarmFileSyntax(query.path);
  return fileReadCache.load(
    workspaceFileReadKey(query),
    () => fetchWorkspaceFileRead(query),
    options,
  );
}

export function loadWorkspaceFileDiff(
  query: WorkspaceFileDiffQuery,
  options: { force?: boolean; maxAgeMs?: number } = {},
): Promise<string> {
  return fileDiffCache.load(
    workspaceFileDiffKey(query),
    () => fetchWorkspaceFileDiff(query),
    options,
  );
}

export function prefetchWorkspaceFileRead(
  cwd: string | undefined,
  path: string | undefined,
  contentRevision = 0,
): void {
  if (!cwd || !path) return;
  void loadWorkspaceFileRead(
    { cwd, path, contentRevision },
    { maxAgeMs: 15_000 },
  ).catch(() => {});
}

export function prefetchWorkspaceFileDiff(
  query: WorkspaceFileDiffQuery | null | undefined,
): void {
  if (!query?.workspaceId || !query.path) return;
  void loadWorkspaceFileDiff(query, { maxAgeMs: 15_000 }).catch(() => {
    // Preserve an existing exact-key snapshot; the visible viewer owns errors.
  });
}

/** Publish content already read for another purpose (currently untracked-file
 * line counts) so the viewer never repeats that IPC. */
export function primeWorkspaceFileRead(
  query: WorkspaceFileReadQuery,
  result: ReadFileResult,
): void {
  fileReadCache.setData(workspaceFileReadKey(query), result);
}

/** Publish a per-file patch parsed from Changes' aggregate diff. */
export function primeWorkspaceFileDiff(
  query: WorkspaceFileDiffQuery,
  patch: string,
): void {
  fileDiffCache.setData(workspaceFileDiffKey(query), patch);
}

export function peekWorkspaceFileRead(
  query: WorkspaceFileReadQuery,
): ReadFileResult | undefined {
  return fileReadCache.getSnapshot(workspaceFileReadKey(query)).data;
}

export function peekWorkspaceFileDiff(
  query: WorkspaceFileDiffQuery,
): string | undefined {
  return fileDiffCache.getSnapshot(workspaceFileDiffKey(query)).data;
}

/** Mark renderer file snapshots stale after a Git/file generation changes.
 * Reads scope by cwd and diffs scope by opaque workspace id when the publisher
 * has both identities. A legacy/coarse publisher can omit the id and invalidate
 * the small bounded diff cache wholesale. Confirmed values remain usable until
 * their next exact-key revalidation completes. */
export function invalidateWorkspaceFileData(
  cwd?: string,
  workspaceId?: string,
): void {
  if (cwd) {
    const normalizedCwd = normalizeCwd(cwd);
    for (const key of fileReadCache.keys()) {
      try {
        const value = JSON.parse(key) as unknown[];
        if (value[0] === normalizedCwd) fileReadCache.invalidate(key);
      } catch {
        // Cache keys are module-owned JSON; ignore a malformed legacy key.
      }
    }
  }
  if (workspaceId) {
    for (const key of fileDiffCache.keys()) {
      try {
        const value = JSON.parse(key) as unknown[];
        if (value[0] === workspaceId) fileDiffCache.invalidate(key);
      } catch {
        // Cache keys are module-owned JSON; ignore a malformed legacy key.
      }
    }
  } else {
    fileDiffCache.invalidateAll();
  }
}

export function invalidateAllWorkspaceFileData(): void {
  fileReadCache.invalidateAll();
  fileDiffCache.invalidateAll();
}

/** Test-only reset. Cache instances stay module singletons in production. */
export function resetWorkspaceFileDataCacheForTests(): void {
  fileReadCache.clear();
  fileDiffCache.clear();
}
