// ──────────────────────────────────────────────────────────
// FileViewer — read-only file content pane (Files tab)
// ──────────────────────────────────────────────────────────
//
// Right column of the Files tab (and the body of a pre-opened Files
// tab). Fetches one file via the `read_file` IPC and renders it:
//   • text   → shiki-highlighted source with a line-number gutter
//   • md     → Preview (rendered) / Code (highlighted source) toggle
//   • image  → inline <img> from the data URL
//   • binary / too-large / error → a quiet placeholder
//
// Read-only by design for v1 — view + copy only. Highlighting reuses
// the shared shiki worker (apps/desktop/src/renderer/features/agent/renderers/syntax.ts); the
// gutter is a sibling column locked to the same line-height so numbers
// stay aligned while the code scrolls horizontally.
// ──────────────────────────────────────────────────────────

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlignJustify,
  Check,
  Columns2,
  FileQuestion,
  FileX2,
  ImageOff,
  Undo2,
} from "lucide-react";
import {
  CodeView as DiffCodeView,
  type CodeViewItem,
} from "@pierre/diffs/react";
import { getSingularPatch } from "@pierre/diffs";

import { isGitErrorShape } from "@/renderer/platform/git";
import { getLang } from "@/renderer/features/agent/renderers/syntax";
import { HighlightedCode } from "@/renderer/features/agent/renderers/highlighted-code";
import { FileTypeIcon } from "@/renderer/features/agent/composer-editor/file-type-icon";
import { renderMarkdown } from "@/renderer/features/agent/markdown";
import { zerosCodeViewOptions } from "@/renderer/shared/theme/diff-theme";
import { useCodeTheme } from "@/renderer/shared/theme/use-code-theme";
import { SourceEditor } from "./code-editor/source-editor";
import { useScrollMemory, useScrollMemoryRef } from "../../scroll-memory";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { CodeBlockCopyButton } from "@/renderer/shared/ui/primitives/elements/code-block";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { cn } from "@/renderer/shared/ui/cn";
import { useInstantViewSwitch } from "@/renderer/shared/ui/use-instant-view-switch";
import { useWorkspaceDispatch } from "@/renderer/state/workspace-store";
import { useOpenFileInWorkbench, type OpenFileOpts } from "../use-open-file";
import type { ViewerMode } from "../tab-model";
import { triggerGitRefresh } from "../../use-git-refresh-key";
import {
  currentFileHash,
  isFileViewed,
  nextUnviewedPath,
  setFileViewed,
  useViewedVersion,
} from "./use-viewed-files";
import { DiscardDialog, discardPath } from "./discard-file";
import { resolveMissingFileDisposition } from "./file-lifecycle";
import { changeAdvanceIntent } from "./changes-open-intent";
import {
  loadWorkspaceFileDiff,
  loadWorkspaceFileRead,
  peekWorkspaceFileDiff,
  peekWorkspaceFileRead,
  useWorkspaceFileDiffSnapshot,
  useWorkspaceFileReadSnapshot,
  workspaceFileReadKey,
  type WorkspaceFileDiffQuery,
  type WorkspaceFileReadQuery,
} from "../../workspace-file-data-cache";
import { setDiffStyle, useDiffStyle } from "./diff-style-store";
import { diffViewVersion } from "./diff-view-version";

interface FileViewerProps {
  /** Owning workbench tab. Used to close only this tab if an external delete leaves
   * neither a working-tree file nor a reviewable Git diff. */
  tabId: string;
  /** Whether this File tab is the currently visible workbench tab. */
  active: boolean;
  /** Workspace/worktree folder the path is relative to. */
  cwd: string | undefined;
  /** Repo-relative path to display. File tabs never exist without one. */
  path: string;
  /** Git target for the Diff view (worktree id, or the trunk's repoRoot). Null
   *  → no diff is fetched (no Diff toggle). */
  workspaceId?: string | null;
  /** Open in Diff mode by default (set when opened from Changes; cleared from
   *  All Files). The Diff toggle still only appears if the file actually has
   *  changes. */
  diff?: boolean;
  /** Which diff to show — mirrors the Changes filter the file was opened from:
   *  "all" (worktree vs base), "uncommitted" (worktree vs HEAD), or "commit"
   *  (that commit's own diff, via `diffSha`). Defaults to "all". */
  diffScope?: "all" | "uncommitted" | "staged" | "unstaged" | "commit" | "turn";
  /** Commit SHA when `diffScope === "commit"`. */
  diffSha?: string;
  /** When `diffScope === "turn"`: the chat + turn whose AUTHORED diff to show
   *  (the per-turn footer / turn-filtered Changes list open files this way). */
  turnChatId?: string;
  turnId?: string;
  /** Show the Discard control — only when opened from the All-changes filter on
   *  a file with uncommitted work (computed by the caller). */
  discardable?: boolean;
  /** True only when live git status classified the path as untracked or
   *  staged-new. Never infer this from an empty diff. */
  isNewFile?: boolean;
  /** Changes after a confirmed on-disk discard to reset any Edit-mode draft. */
  contentRevision?: number;
  /** Owning tab's explicit mode selection; undefined follows open intent. */
  viewerMode?: ViewerMode;
  /** Persist an explicit mode choice on the owning workspace tab. */
  onViewerModeChange?: (mode: ViewerMode) => void;
  /** Parent-owned Git/file generation. One coordinator per mounted tab surface
   * prevents every retained file layer from registering duplicate bridge and
   * agent-stream listeners. */
  refreshKey: number;
  /** Read-only target → hide the Discard action regardless. */
  readOnly?: boolean;
  /** Rendered at the START of the header row, before the path breadcrumbs. The
   *  workbench Changes and Files tabs inject their sidebar controls here while the
   *  respective sidebar is hidden, so toolbar + file + viewer controls read as
   *  ONE row. */
  headerLeading?: React.ReactNode;
  /** Where "open another file" lands (the Viewed auto-advance sweep). Default:
   *  the shared workbench open flow (follow/reuse the active File tab). The Changes
   *  tab overrides this to advance its OWN selection in place — without it the
   *  sweep would spawn a separate File tab and yank away from the Changes tab. */
  onOpenPath?: (path: string, opts: OpenFileOpts) => void;
}

const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);

function extOf(p: string): string {
  const dot = p.lastIndexOf(".");
  const slash = p.lastIndexOf("/");
  return dot > slash ? p.slice(dot + 1).toLowerCase() : "";
}
function baseOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** Git represents binary changes with a marker rather than line hunks. Do not
 * hand those markers to the text-diff renderer while the source probe is still
 * resolving; ordinary aggregate patches are complete render inputs already. */
function isBinaryGitPatch(patch: string): boolean {
  return /(?:^|\n)(?:GIT binary patch|Binary files .+ differ)(?:\n|$)/.test(
    patch,
  );
}

/** The open file's repo-relative path as breadcrumbs: the colored file-type
 *  glyph + parent dirs (muted, ellipsised when long) + filename (emphasised,
 *  never clipped). Display-only; the full path shows on hover. */
function PathBreadcrumbs({ path }: { path: string }) {
  const file = baseOf(path);
  const dir =
    path.length > file.length ? path.slice(0, -(file.length + 1)) : "";
  return (
    <Tooltip label={path}>
      <div className="border-border1 flex min-w-0 items-center gap-1.5 rounded-sm border px-2 py-1">
        <FileTypeIcon name={path} size={13} />
        <div className="flex min-w-0 items-center text-xs">
          {dir && (
            <>
              <span className="text-fg2 truncate">{dir}</span>
              <span className="text-fg2/50 shrink-0">/</span>
            </>
          )}
          <span className="text-fg1 shrink-0 font-medium">{file}</span>
        </div>
      </div>
    </Tooltip>
  );
}

export function FileViewer({
  tabId,
  active,
  cwd,
  path,
  workspaceId,
  diff,
  diffScope,
  diffSha,
  turnChatId,
  turnId,
  discardable,
  isNewFile,
  contentRevision,
  viewerMode,
  onViewerModeChange,
  refreshKey,
  readOnly,
  headerLeading,
  onOpenPath,
}: FileViewerProps) {
  const viewerRef = useRef<HTMLDivElement | null>(null);

  // Keyed scroll memory for this file's read-only surfaces — diff, source,
  // and markdown preview each keep their own offset (see shell/scroll-memory).
  // Viewers remount on workspace switches and deck eviction; the key brings
  // the reading position back on return.
  const scrollKeyBase = JSON.stringify(["file", cwd ?? "", tabId, path]);
  const previewScrollRef = useScrollMemoryRef(
    JSON.stringify([scrollKeyBase, "preview"]),
  );
  const diffScrollKey = JSON.stringify([
    scrollKeyBase,
    "diff",
    workspaceId ?? "",
    diffScope ?? "all",
    diffSha ?? "",
    turnChatId ?? "",
    turnId ?? "",
  ]);

  const readQuery = useMemo<WorkspaceFileReadQuery>(
    () => ({
      cwd: cwd ?? "",
      path,
      contentRevision: contentRevision ?? 0,
    }),
    [cwd, path, contentRevision],
  );
  const diffQuery = useMemo<WorkspaceFileDiffQuery>(
    () => ({
      workspaceId: workspaceId ?? "",
      path,
      diffScope,
      diffSha,
      turnChatId,
      turnId,
    }),
    [workspaceId, path, diffScope, diffSha, turnChatId, turnId],
  );
  // useSyncExternalStore gives the destination its exact cached snapshot in
  // the selection render. There is no component-local "loading reset" paint.
  const readSnapshot = useWorkspaceFileReadSnapshot(readQuery);
  const diffSnapshot = useWorkspaceFileDiffSnapshot(diffQuery);
  const readKey = workspaceFileReadKey(readQuery);
  useInstantViewSwitch(
    active ? `file:${cwd ?? ""}:${readKey}` : "file:hidden",
    viewerRef,
  );

  const isMarkdown = MARKDOWN_EXT.has(extOf(path));

  // Unified vs split is one synchronized global preference; every retained
  // viewer observes the same external-store snapshot immediately.
  const diffStyle = useDiffStyle();

  // Workbench review controls (Viewed / Discard). Subscribe so the checkbox + the
  // Changes-list dimming stay in sync on any mark / unmark / auto-unmark.
  useViewedVersion();
  const openInWorkbench = useOpenFileInWorkbench();
  const dispatch = useWorkspaceDispatch();
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);
  const [discardingPath, setDiscardingPath] = useState<string | null>(null);
  // Live refresh: re-read content + re-fetch the diff when a git write lands
  // (Discard / stage / commit → the engine broadcasts DB_CHANGED) or the active
  // agent ends a turn (file edits). Keeps the open file/diff current instead of
  // going stale until the tab is re-opened.
  // Revalidate on target/git generations without clearing a completed value.
  // Hover/workspace-intent prefetch usually makes this a background refresh;
  // concurrent callers share the same keyed request.
  useEffect(() => {
    if (!cwd) return;
    // A hidden retained view already has a confirmed snapshot. Its cache was
    // marked stale by the parent refresh coordinator; defer bridge work until
    // it is selected again. A cold hidden intent-view still loads now.
    if (!active && peekWorkspaceFileRead(readQuery) !== undefined) return;
    void loadWorkspaceFileRead(readQuery, { maxAgeMs: 15_000 }).catch(() => {});
  }, [active, cwd, readQuery, readKey, refreshKey]);

  // Fetch the file's diff for the filter it was opened from: "all" = worktree vs
  // base (committed + uncommitted), "uncommitted" = worktree vs HEAD, "commit" =
  // that commit's own diff (vs its parent). Re-fetches on gitRefresh too; the
  // diff spinner shows only on a fresh file/scope (no flicker on live refresh).
  useEffect(() => {
    if (!workspaceId) return;
    if (!active && peekWorkspaceFileDiff(diffQuery) !== undefined) return;
    void loadWorkspaceFileDiff(diffQuery, { maxAgeMs: 15_000 }).catch(() => {
      // The snapshot carries the error; a confirmed diff stays available.
    });
  }, [active, workspaceId, diffQuery, contentRevision, refreshKey]);

  // A file-list click can replace a clean File tab's path in place. Ignore the
  // previous path's last read during the one render before the new read effect
  // enters loading; it must never seed the new editor with the old file text.
  const diskResult =
    readSnapshot.data?.path === path ? readSnapshot.data : null;
  const fileMissing =
    diskResult?.path === path &&
    diskResult?.kind === "error" &&
    diskResult.error === "file no longer exists on disk";
  const result = diskResult;
  const isText = result?.kind === "text";
  const readLoading = !result && readSnapshot.loading;
  const readFailed = !result && !readSnapshot.loading && !!readSnapshot.error;
  const rawDiff = workspaceId ? (diffSnapshot.data ?? null) : "";
  const diffLoading = rawDiff === null && diffSnapshot.loading;
  const diffFailed = rawDiff === null && !diffLoading && !!diffSnapshot.error;

  // The diff to render: the git patch if present; for a live-status-confirmed
  // new file opened from Changes — absent from `git diff` — synthesize an
  // all-additions patch from its contents. Never infer "new" from rawDiff ===
  // "": that is also the normal post-discard state of a tracked file. NOT for
  // commit scope, where an empty diff means the file isn't part of that commit.
  // Text-only, so a tracked binary's "Binary files … differ" never leaks in.
  const sourceBlocksTextDiff =
    result?.kind === "binary" || result?.kind === "image";
  const aggregateTextPatchReady =
    typeof rawDiff === "string" &&
    rawDiff.length > 0 &&
    !isBinaryGitPatch(rawDiff);
  const diffPatch = useMemo(() => {
    // A deleted tracked file has no source result, but its deletion patch is a
    // valid, useful review surface. This is the one non-text-reader state whose
    // raw Git patch we intentionally render.
    if (aggregateTextPatchReady && !sourceBlocksTextDiff) return rawDiff ?? "";
    if (result?.kind !== "text") return "";
    if (
      rawDiff === "" &&
      diff &&
      isNewFile &&
      diffScope !== "commit" &&
      diffScope !== "turn" &&
      result.content != null
    )
      return buildAddPatch(path, result.content);
    return "";
  }, [
    aggregateTextPatchReady,
    sourceBlocksTextDiff,
    rawDiff,
    result,
    diff,
    diffScope,
    isNewFile,
    path,
  ]);

  // The selected COMMIT doesn't touch this file (empty commit diff, resolved).
  // Show an honest "not part of this commit" state rather than a faked diff.
  const notInCommit =
    isText && diffScope === "commit" && !diffLoading && rawDiff === "";

  // "Diff is available": opened from Changes we KNOW it changed (intent), even
  // while the patch is still loading; from All Files only once a non-empty diff
  // comes back. Also true for notInCommit, so the Diff view can show the
  // explanation instead of silently dropping to the source.
  // A Changes click carries diff intent before either exact-key read settles.
  // Keep it in Diff mode and let its delayed cold spinner own the wait. When
  // Changes primed the aggregate patch, no source read is needed at all.
  const canRenderDiff =
    !sourceBlocksTextDiff &&
    (diff === true || isText || fileMissing || diffPatch.length > 0);
  const hasDiff =
    diffPatch.length > 0 ||
    (diff && canRenderDiff && (diffLoading || diffFailed));
  const diffAvailable = hasDiff || notInCommit;
  const missingDisposition = resolveMissingFileDisposition({
    fileMissing,
    diffIntent: diff === true,
    diffPendingOrAvailable: diffLoading || diffAvailable,
  });

  // Effective mode: the user's pick, else the entry-point default, clamped off
  // Diff only when there's nothing diff-related to show (purely derived — no
  // effect races, so a Changes click lands on Diff immediately).
  // A successful tracked discard bumps contentRevision: land in Edit even for
  // Markdown (whose ordinary All Files default is Preview), exactly matching
  // the post-discard workflow. A later explicit file-open clears the revision
  // marker and restores the entry point's normal default.
  const autoMode: ViewerMode = diff
    ? "diff"
    : contentRevision
      ? "edit"
      : isMarkdown
        ? "preview"
        : "edit";
  // If the source disappeared but Git has a deletion patch, Diff is the only
  // meaningful surface — switch there even if Edit had been explicitly chosen.
  let mode: ViewerMode =
    missingDisposition === "review-diff" ? "diff" : (viewerMode ?? autoMode);
  if (mode === "diff" && !diffAvailable) mode = isMarkdown ? "preview" : "edit";

  const diffShown =
    missingDisposition !== "show-missing" &&
    canRenderDiff &&
    mode === "diff" &&
    diffAvailable;
  const previewShown = isText && mode === "preview" && isMarkdown;
  const sourceShown = isText && !diffShown && !previewShown;

  // ── Viewed + Discard (header review actions) ──
  const viewed = !!workspaceId && !!path && isFileViewed(workspaceId, path);
  // After marking viewed or discarding, open the next change (directional
  // sweep). Follows the active tab in Diff mode — since the viewer IS the active
  // File tab, the current file is "closed" by being swapped out; null → stay
  // (nothing left to review).
  const advance = useCallback(() => {
    if (!workspaceId || !path) return;
    const next = nextUnviewedPath(workspaceId, path);
    // Keep the sweep in the same filter. The Changes tab supplies onOpenPath so
    // the sweep advances ITS selection instead of opening a separate workbench File
    // tab; standalone File tabs use the preserved identity below.
    if (next)
      (onOpenPath ?? openInWorkbench)(
        next,
        changeAdvanceIntent({
          diffScope,
          diffSha,
          turnChatId,
          turnId,
        }),
      );
  }, [
    workspaceId,
    path,
    onOpenPath,
    openInWorkbench,
    diffScope,
    diffSha,
    turnChatId,
    turnId,
  ]);
  const toggleViewed = useCallback(() => {
    if (!workspaceId || !path) return;
    if (isFileViewed(workspaceId, path)) {
      setFileViewed(workspaceId, path, false); // un-view → stay on the file
    } else {
      setFileViewed(
        workspaceId,
        path,
        true,
        currentFileHash(workspaceId, path),
      );
      advance();
    }
  }, [workspaceId, path, advance]);
  const onDiscardConfirm = useCallback(() => {
    // A retained Changes viewer can switch paths while a dialog is open. The
    // dialog is rendered only for its captured path, and a late confirm can
    // never be redirected to the replacement path.
    const targetPath = discardTarget;
    setDiscardTarget(null);
    if (!workspaceId || !cwd || !targetPath || targetPath !== path) return;
    const targetScope = cwd;
    setDiscardingPath(targetPath);
    // Reconcile the actual live-status outcome: new paths (and reverted rename
    // destinations) close, while tracked paths stay open and switch to Edit.
    // The explicit scope prevents an async completion from touching another
    // worktree after the user switches away.
    void discardPath(workspaceId, targetPath, {
      expectedNew: isNewFile === true,
    })
      .then((outcome) => {
        dispatch({
          type: "RECONCILE_WORKBENCH_FILE_DISCARD",
          scope: targetScope,
          path: targetPath,
          outcome,
        });
        // The bridge excludes the originator from DB_CHANGED (and an untracked
        // clean used to emit no workspace invalidation at all). Nudge every
        // consumer only after the full discard sequence completes.
        triggerGitRefresh(targetScope);
      })
      .catch((error: unknown) => {
        toast.error(`Couldn't discard ${baseOf(targetPath)}`, {
          description: isGitErrorShape(error)
            ? (error.remediation ?? error.message)
            : error instanceof Error
              ? error.message
              : String(error),
        });
        // A multi-step discard (staged-new = unstage, then clean) may have
        // changed Git before a later step failed. Re-pull authoritative state
        // even on error so workbench, All Files, the list, and the badge cannot
        // remain on the pre-operation snapshot.
        triggerGitRefresh(targetScope);
      })
      .finally(() => {
        setDiscardingPath((current) =>
          current === targetPath ? null : current,
        );
      });
  }, [workspaceId, cwd, path, discardTarget, dispatch, isNewFile]);
  // Highlighting is owned by <HighlightedCode> (sync once warm → no flash).
  const codeLang = isMarkdown ? "markdown" : getLang(path);

  const previewHtml = useMemo(
    () => (previewShown ? renderMarkdown(result?.content ?? "") : null),
    [previewShown, result],
  );

  const canCopy = result?.kind === "text" && result.content != null;

  // Design territory has exactly one write path — the design surface — so the
  // engine refuses generic editor writes, staging and discard for these paths
  // in EVERY mode (modes are concurrent; an agent can be working in code
  // territory while the canvas is open). Rendering read-only here keeps the UI
  // from offering an action the engine is going to reject. The engine remains
  // the authority: if a transport omits the tag we simply behave as before.
  const designReadOnly = result?.designPath === true;
  const sourceReadOnly = readOnly || designReadOnly;

  // Mode toggle: markdown → Preview/Edit (+ Diff when a diff is available); other
  // text → Edit (+ Diff). "Diff" stays available for notInCommit so the user can
  // see the "not part of this commit" explanation. A lone option renders no toggle.
  const modeOptions: ViewerMode[] = isMarkdown
    ? diffAvailable
      ? ["diff", "preview", "edit"]
      : ["preview", "edit"]
    : diffAvailable
      ? ["diff", "edit"]
      : ["edit"];
  const showToggle = isText && modeOptions.length > 1;

  return (
    <div ref={viewerRef} className="bg-bg1 flex h-full min-h-0 flex-col">
      {/* Header — path breadcrumbs + (mode toggle) + copy, one row. h-9 +
          px-2: the same chrome band height + inset as the browser toolbar
          and the terminal sub-tab strip (was h-10/px-3). No bottom border —
          the file view flows straight into the code with no seam. */}
      <div className="bg-bg1 flex h-9 shrink-0 items-center justify-between gap-2 px-2">
        <div className="flex min-w-0 items-center gap-2">
          {headerLeading}
          {path ? (
            <PathBreadcrumbs path={path} />
          ) : (
            <span className="text-fg2 truncate text-xs font-medium">
              No file open
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Viewed — when the file has changes. Dims its Changes-list row and
              auto-advances to the next change (D3). */}
          {hasDiff && (
            <Tooltip label={viewed ? "Mark as not viewed" : "Mark as viewed"}>
              <button
                type="button"
                onClick={toggleViewed}
                className="text-fg2 hover:text-fg1 flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs transition-colors"
              >
                <span
                  className={cn(
                    "flex size-3.5 items-center justify-center rounded-sm border transition-colors",
                    viewed ? "border-fg2 bg-fg2 text-bg1" : "border-border3",
                  )}
                >
                  {viewed && <Check className="size-2.5" strokeWidth={3} />}
                </span>
                Viewed
              </button>
            </Tooltip>
          )}
          {/* Discard — ONLY when opened from the All-changes filter on a file
              with uncommitted work (discardable) and a writable target. */}
          {discardable &&
            !sourceReadOnly &&
            (!fileMissing || diffAvailable) && (
              <Tooltip
                label={isNewFile ? "Delete untracked file" : "Discard changes"}
              >
                <button
                  type="button"
                  onClick={() => setDiscardTarget(path)}
                  disabled={discardingPath === path}
                  aria-busy={discardingPath === path}
                  className="text-fg2 hover:bg-bg2-hover hover:text-fg1 flex size-6 items-center justify-center rounded-sm transition-colors disabled:cursor-wait disabled:opacity-50"
                >
                  <Undo2 className="size-3.5" />
                </button>
              </Tooltip>
            )}
          {/* Unified ⇄ split — only in Diff mode. */}
          {diffShown && (
            <div className="bg-bg2 flex items-center rounded-md p-0.5">
              {(
                [
                  ["unified", AlignJustify],
                  ["split", Columns2],
                ] as const
              ).map(([s, Icon]) => (
                <Tooltip
                  key={s}
                  label={s === "unified" ? "Unified view" : "Split view"}
                >
                  <button
                    type="button"
                    onClick={() => setDiffStyle(s)}
                    className={cn(
                      "flex items-center rounded-sm p-1 transition-colors",
                      diffStyle === s
                        ? "bg-bg1 text-fg1 shadow-sm"
                        : "text-fg2 hover:text-fg1",
                    )}
                  >
                    <Icon className="size-3.5" />
                  </button>
                </Tooltip>
              ))}
            </div>
          )}
          {canCopy && (
            <CodeBlockCopyButton
              text={result!.content ?? ""}
              className="size-6"
            />
          )}
          {showToggle && (
            <div className="bg-bg2 flex items-center rounded-md p-0.5 text-xs">
              {modeOptions.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => onViewerModeChange?.(v)}
                  className={cn(
                    "rounded-sm px-2 py-0.5 capitalize transition-colors",
                    mode === v
                      ? "bg-bg1 text-fg1 shadow-sm"
                      : "text-fg2 hover:text-fg1",
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Body. */}
      <div
        className="min-h-0 flex-1 overflow-hidden"
        aria-busy={readLoading || diffLoading || undefined}
      >
        {readFailed && !diffShown && (
          <Placeholder
            Icon={FileX2}
            text="Couldn't reach the file reader — try restarting the app"
          />
        )}
        {result?.kind === "binary" && !diffShown && (
          <Placeholder
            Icon={FileX2}
            text="Binary file — preview not available"
          />
        )}
        {result?.kind === "too-large" && !diffShown && (
          <Placeholder
            Icon={FileX2}
            text={`File too large to preview (${(result.bytes / 1_000_000).toFixed(1)} MB)`}
          />
        )}
        {result?.kind === "error" && !fileMissing && !diffShown && (
          <Placeholder
            Icon={FileX2}
            text={result.error ?? "Couldn't read this file"}
          />
        )}
        {missingDisposition === "show-missing" && !diffShown && (
          <Placeholder Icon={FileX2} text="file no longer exists on disk" />
        )}
        {result?.kind === "image" && !diffShown && (
          <div className="flex h-full items-center justify-center overflow-auto p-4">
            {result.dataUrl ? (
              <img
                src={result.dataUrl}
                alt={path}
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <Placeholder Icon={ImageOff} text="Image unavailable" />
            )}
          </div>
        )}
        {diffShown &&
          (notInCommit ? (
            <Placeholder
              Icon={FileQuestion}
              text={`${baseOf(path)} isn’t part of this commit`}
            />
          ) : diffFailed ? (
            <Placeholder
              Icon={FileX2}
              text={
                diffSnapshot.error?.message ?? "Couldn't read this file's diff"
              }
            />
          ) : diffLoading ? (
            <div className="h-full" aria-busy="true" />
          ) : (
            <DiffView
              patch={diffPatch}
              diffStyle={diffStyle}
              scrollKey={diffScrollKey}
            />
          ))}
        {previewShown && previewHtml !== null && (
          <div
            ref={previewScrollRef}
            className="h-full overflow-x-hidden overflow-y-auto px-5 py-4"
          >
            <MarkdownPreview html={previewHtml} />
          </div>
        )}
        {sourceShown && sourceReadOnly && (
          <div className="flex h-full min-h-0 flex-col">
            {designReadOnly && (
              <div className="text-fg3 bg-bg2 border-bd1 shrink-0 border-b px-5 py-2 text-xs">
                Design files are edited in Design Mode and committed with “Save
                designs”.
              </div>
            )}
            <div className="min-h-0 flex-1">
              <CodeView
                content={result?.content ?? ""}
                lang={codeLang}
                scrollKey={JSON.stringify([scrollKeyBase, "source"])}
              />
            </div>
          </div>
        )}
        {/* Keep a writable editor mounted while Diff/Preview is selected. Its
            draft + dirty registration then survive every workbench view switch;
            only the owning File tab closing (or a destructive reset revision)
            intentionally unmounts it. */}
        {isText && !sourceReadOnly && (
          <div
            className={cn("h-full", !sourceShown && "hidden")}
            aria-hidden={!sourceShown || undefined}
          >
            <SourceEditor
              key={`${cwd}::${path}::${contentRevision ?? 0}`}
              editorId={tabId}
              cwd={cwd ?? ""}
              path={path}
              content={result?.content ?? ""}
              offscreen={!sourceShown}
            />
          </div>
        )}
      </div>

      {discardTarget === path && (
        <DiscardDialog
          path={discardTarget}
          isNew={isNewFile === true}
          onCancel={() => setDiscardTarget(null)}
          onConfirm={onDiscardConfirm}
        />
      )}
    </div>
  );
}

// ── Diff view (workbench, virtualized @pierre/diffs CodeView) ──────

/** Synthetic all-additions unified diff for a brand-new (untracked) file —
 *  absent from `git diff`, so the Diff view can still render it as created.
 *  Mirrors the synthetic-add the old Changes pane built for untracked rows. */
function buildAddPatch(path: string, content: string): string {
  if (!path || content.length === 0) return "";
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = body.split("\n");
  const head =
    `diff --git a/${path} b/${path}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${lines.length} @@\n`;
  return head + lines.map((l) => `+${l}`).join("\n") + "\n";
}

/** The Diff mode: the file's change rendered with the virtualized <CodeView>
 *  (only the visible lines paint, so even huge/minified diffs stay smooth),
 *  highlighted off the main thread by the worker pool. Themed identically to
 *  the chat EditCard + the Review tab. */
function DiffView({
  patch,
  diffStyle,
  scrollKey,
}: {
  patch: string;
  diffStyle: "unified" | "split";
  scrollKey?: string;
}) {
  // Follow the unified code theme (re-render + re-highlight on a picker change).
  const codeTheme = useCodeTheme();
  // DiffCodeView's ROOT is the scroll container but the library doesn't
  // expose a ref to it, so a thin wrapper adopts its first child. Ref
  // callbacks run parent-after-children within a commit, so the library's
  // DOM already exists when this fires.
  const [diffScroller, setDiffScroller] = useState<HTMLElement | null>(null);
  const diffWrapRef = useCallback((node: HTMLDivElement | null) => {
    setDiffScroller((node?.firstElementChild as HTMLElement | null) ?? null);
  }, []);
  useScrollMemory(diffScroller, scrollKey ?? null);
  // getSingularPatch parses one file's patch → the FileDiffMetadata CodeView
  // wants; it throws on a non-single-file / malformed patch, so guard it.
  const items = useMemo<CodeViewItem[]>(() => {
    try {
      return [
        {
          id: "file",
          type: "diff" as const,
          // CodeView reconciles stable ids by this explicit version. Without
          // it, a live patch update keeps the old parsed AST and visible DOM.
          version: diffViewVersion(patch),
          fileDiff: getSingularPatch(patch),
        },
      ];
    } catch {
      return [];
    }
  }, [patch]);
  const options = useMemo(
    // Drop the in-diff file header (the green +-icon / filename / "+N" badge
    // row): the file-viewer's own toolbar above already shows the path
    // breadcrumbs, so the diff body starts straight at the code — matching the
    // chat EditCard, which disables the same header for the same reason.
    () =>
      zerosCodeViewOptions({
        diffStyle,
        codeThemeId: codeTheme,
        disableFileHeader: true,
      }),
    [diffStyle, codeTheme],
  );
  if (items.length === 0) {
    return <Placeholder Icon={FileQuestion} text="No textual diff to show" />;
  }
  // CodeView is the scroll container, but it does NOT set overflow on its own
  // root. Workbench's shared provider supplies the off-main-thread worker pool.
  return (
    <div ref={diffWrapRef} className="h-full min-h-0">
      <DiffCodeView
        items={items}
        options={options}
        className="relative h-full overflow-x-hidden overflow-y-auto"
      />
    </div>
  );
}

// ── Code view with a line-number gutter ────────────────────

function CodeView({
  content,
  lang,
  scrollKey,
}: {
  content: string;
  lang: string;
  scrollKey?: string;
}) {
  const scrollRef = useScrollMemoryRef(scrollKey ?? null);
  // Line count drives the gutter. Strip a single trailing newline so we
  // don't render a phantom final number that shiki doesn't paint.
  const lineCount = useMemo(() => {
    const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
    return trimmed.length === 0 ? 1 : trimmed.split("\n").length;
  }, [content]);

  const gutter = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => i + 1),
    [lineCount],
  );

  return (
    <div
      ref={scrollRef}
      className="bg-bg1 h-full overflow-auto font-mono text-xs leading-[1.6]"
    >
      <div className="flex min-w-full">
        <div
          aria-hidden
          className="border-border1 bg-bg1 text-fg2/45 sticky left-0 z-10 shrink-0 border-r px-3 py-3 text-right select-none"
        >
          {gutter.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
        {/* HighlightedCode renders highlighted on first paint once the shiki
            highlighter is warm (no white flash); cold, it shows the plain
            placeholder and swaps in colors. Neutralize shiki's <pre> padding
            and lock line-height so rows line up 1:1 with the gutter numbers. */}
        <HighlightedCode
          code={content}
          lang={lang}
          className={cn(
            "text-fg1 min-w-0 flex-1 py-3 pr-6 pl-4",
            "[&_code]:!leading-[1.6] [&_pre]:p-0 [&_pre]:!leading-[1.6]",
            "[&_.line]:!leading-[1.6]",
          )}
        />
      </div>
    </div>
  );
}

// ── Markdown preview ───────────────────────────────────────

export function MarkdownPreview({ html }: { html: string }) {
  return (
    <div
      className={cn(
        "text-fg1 max-w-3xl min-w-0 text-sm leading-relaxed wrap-anywhere",
        "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold first:[&_h1]:mt-0",
        "[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold",
        "[&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold",
        "[&_p]:my-3",
        "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6",
        "[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6",
        "[&_li]:my-1",
        "[&_a]:underline [&_a]:underline-offset-2",
        "[&_code]:bg-bg2 [&_code]:rounded-sm [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
        "[&_pre]:bg-bg2/40 [&_pre]:my-3 [&_pre]:overflow-x-hidden [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:break-words [&_pre]:whitespace-pre-wrap",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:break-words [&_pre_code]:whitespace-pre-wrap",
        "[&_blockquote]:border-border2 [&_blockquote]:text-fg2 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3",
        "[&_table]:my-3 [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse",
        "[&_th]:border-border1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:wrap-anywhere",
        "[&_td]:border-border1 [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_td]:wrap-anywhere",
        "[&_hr]:border-border1 [&_hr]:my-5",
        "[&_img]:max-w-full",
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ── Shared placeholder ─────────────────────────────────────

function Placeholder({
  Icon,
  text,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  text: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <Icon className="text-fg2/60 size-6" />
      <p className="text-fg2 m-0 text-xs">{text}</p>
    </div>
  );
}
