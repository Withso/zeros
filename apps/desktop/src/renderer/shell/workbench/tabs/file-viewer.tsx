import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import {
  changesHistoryKey,
  type ChangesHistory,
} from "@zeros/protocol/changes-history";
// ──────────────────────────────────────────────────────────
// FileViewer — read-only file content pane (Files tab)
// ──────────────────────────────────────────────────────────
//
// Content column of the Files tab (and the body of a pre-opened Files tab).
// Fetches one file via the `read_file` IPC and renders it:
//   • text   → shiki-highlighted source with a line-number gutter
//   • md     → Preview (rendered) / Code (highlighted source) toggle
//   • image/video → bounded media with zoom, pan, copy and download
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
import { createPortal } from "react-dom";
import {
  AlignJustify,
  Columns2,
  FileQuestion,
  FileX2,
  ImageOff,
  Undo2,
} from "lucide-react";
import { isGitErrorShape } from "@/renderer/platform/git";
import { FileTypeIcon } from "@/renderer/features/agent/composer-editor/file-type-icon";
import {
  ReviewDiffView,
  ReviewSourceView,
} from "@/renderer/features/code-review/review-code-view";
import {
  useCodeReview,
  type CodeReviewController,
} from "@/renderer/features/code-review/use-code-review";
import type { CodeReviewExternalSource } from "@/renderer/features/code-review/review-thread-model";
import { useWorkspaceReviewStatus } from "@/renderer/features/code-review/use-workspace-review-status";
import { ConflictNavigator } from "@/renderer/features/code-review/conflict-navigator";
import { conflictRowsStyle } from "@/renderer/features/code-review/merge-conflict-pierre";
import { conflictMarkerNotice } from "@/renderer/features/code-review/merge-conflict-rows";
import { parseMergeConflicts } from "@zeros/protocol/merge-conflicts";
import { MessageRow } from "@/renderer/shared/ui/primitives/message-row";
import { SourceEditor } from "./code-editor/source-editor";
import { forgetEditorDraft } from "./code-editor/draft-journal";
import { FileEditorOptions, type FileEditorControls } from "./code-editor/file-editor-options";
import { useFileEditorPreferences } from "./code-editor/editor-preferences";
import { parseContextAttachmentPath } from "@zeros/protocol/attachment-policy";
import { useScrollMemory, useScrollMemoryRef } from "../../scroll-memory";
import {
  Checkbox,
  IconButton,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
} from "@/renderer/shared/ui/primitives";
import { CodeBlockCopyButton } from "@/renderer/shared/ui/primitives/elements/code-block";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import {
  WorkbenchTabToolbar,
  WorkbenchTabStatusScope,
  WorkbenchEmptyState,
  useWorkbenchStatusSource,
} from "../tab-status";
import { cn } from "@/renderer/shared/ui/cn";
import { useInstantViewSwitch } from "@/renderer/shared/ui/use-instant-view-switch";
import { EmptyState } from "@/renderer/shared/ui/layout/empty-state";
import { useWorkspaceDispatch } from "@/renderer/state/workspace-store";
import {
  useOpenFileInWorkbench,
  useOpenLinkedFileInWorkbench,
  type OpenFileOpts,
} from "../use-open-file";
import type { ViewerMode } from "../tab-model";
import {
  WORKBENCH_TITLE_CHIP_CLS,
  WORKBENCH_TITLE_ACTION_CLS,
} from "../tab-chrome";
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
  prefetchWorkspaceFileRead,
  useWorkspaceFileDiffSnapshot,
  useWorkspaceFileReadSnapshot,
  workspaceFileReadKey,
  type WorkspaceFileDiffQuery,
  type WorkspaceFileReadQuery,
} from "../../workspace-file-data-cache";
import { setDiffStyle, useDiffStyle } from "./diff-style-store";
import { statusForGeneration } from "./changes-tab";
import type { SkillSource } from "../../../platform/skill-source";
import { Inline } from "@/renderer/shared/ui/layout/inline";
import { FileMediaPreview } from "./file-media-preview";
import { MarkdownPreview } from "./markdown-preview";
import { fileMediaType } from "@zeros/protocol/file-media";
const FilePdfPreview = React.lazy(() => import("./file-pdf-preview").then(module => ({ default: module.FilePdfPreview })));
const FileWordPreview = React.lazy(() => import("./file-word-preview").then(module => ({ default: module.FileWordPreview })));
import { usePendingFilePreview } from "@/renderer/platform/pending-file-preview";
import { useDocumentActive } from "@/renderer/state/use-document-active";

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
  /** Git-root-relative identity when the chat's cwd is a subdirectory. */
  gitPath?: string;
  /** Files alone enables current-source editing and its options menu. */
  fileEditor?: boolean;
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
  diffScope?:
    | "all"
    | "uncommitted"
    | "staged"
    | "unstaged"
    | "commit"
    | "turn"
    | "history";
  /** Commit SHA when `diffScope === "commit"`. */
  diffSha?: string;
  diffHistory?: ChangesHistory;
  diffBaseBranch?: string;
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
  /** Hide the Diff/Preview/Edit choice while retaining the selected surface.
   *  Changes uses this only for its legacy unsaved-draft compatibility layer. */
  showModeToggle?: boolean;
  /** Parent-owned Git/file generation. One coordinator per mounted tab surface
   * prevents every retained file layer from registering duplicate bridge and
   * agent-stream listeners. */
  refreshKey: number;
  /** Read-only target → hide the Discard action regardless. */
  readOnly?: boolean;
  skillSource?: SkillSource;
  /** Rendered at the START of the header row, before the path breadcrumbs. The
   *  workbench Changes tab keeps its scope and turn filters here. */
  headerLeading?: React.ReactNode;
  /** Rendered at the END of the header row, after the viewer controls. The
   *  Files tab injects its fixed right-sidebar controls here, keeping those
   *  actions on one full-width row whether the tree is visible or hidden. */
  headerTrailing?: React.ReactNode;
  /** Optional shared header host for retained viewers. Undefined keeps the
   *  header inline; null hides it for an unselected retained viewer. */
  headerContainer?: HTMLElement | null;
  /** Separate the Files/Changes toolbar from the viewer body with a border. */
  headerBorder?: boolean;
  /** Rendered beside the file content but below the full-width header. The
   *  Files tab injects its resize seam and right-side tree body here. */
  bodyTrailing?: React.ReactNode;
  /** Where "open another file" lands (the Viewed auto-advance sweep). Default:
   *  the shared workbench open flow (follow/reuse the active File tab). The Changes
   *  tab overrides this to advance its OWN selection in place — without it the
   *  sweep would spawn a separate File tab and yank away from the Changes tab. */
  onOpenPath?: (path: string, opts: OpenFileOpts) => void;
  reviewExternal?: CodeReviewExternalSource;
}

const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);

/** The view switch's labels; a skill or attachment calls its source Code. */
const VIEWER_MODE_LABEL = {
  preview: "Preview",
  edit: "Edit",
  diff: "Diff",
  code: "Code",
} as const;

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
function PathBreadcrumbs({ path, truncateFilename = false }: { path: string; truncateFilename?: boolean }) {
  const file = baseOf(path);
  const dir =
    path.length > file.length ? path.slice(0, -(file.length + 1)) : "";
  return (
    <Tooltip label={path}>
      <div className={WORKBENCH_TITLE_CHIP_CLS}>
        <FileTypeIcon name={path} size={14} />
        <div className="flex min-w-0 items-center text-xs">
          {dir && (
            <>
              <span className="text-fg2 truncate">{dir}</span>
              <span className="text-fg2/50 shrink-0">/</span>
            </>
          )}
          <span className={cn("text-fg1 font-medium", truncateFilename ? "min-w-0 truncate" : "shrink-0")}>{file}</span>
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
  gitPath = path,
  fileEditor = false,
  workspaceId,
  diff,
  diffScope,
  diffSha,
  diffHistory,
  diffBaseBranch,
  turnChatId,
  turnId,
  discardable,
  isNewFile,
  contentRevision,
  viewerMode,
  onViewerModeChange,
  showModeToggle = true,
  refreshKey,
  readOnly,
  skillSource,
  headerLeading,
  headerTrailing,
  headerContainer,
  headerBorder,
  bodyTrailing,
  onOpenPath,
  reviewExternal,
}: FileViewerProps) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const [mediaActionsContainer, setMediaActionsContainer] = useState<HTMLSpanElement | null>(null);
  const editorPreferences = useFileEditorPreferences();
  const [editorControls, setEditorControls] = useState<{ key: string; value: FileEditorControls | null } | null>(null);
  const editorKey = JSON.stringify([cwd, path, contentRevision ?? 0]);
  const onEditorControls = useCallback((value: FileEditorControls | null) => setEditorControls({ key: editorKey, value }), [editorKey]);
  const currentEditorControls = editorControls?.key === editorKey ? editorControls.value : null;
  const editorConflicts = currentEditorControls?.conflicts ?? null;
  const review = useCodeReview({
    cwd,
    workspaceId,
    active: active && !skillSource,
    refreshKey,
    external: reviewExternal,
  });
  const gitStatus = useWorkspaceReviewStatus({
    cwd,
    workspaceId,
    active: active && !skillSource,
    refreshKey,
    read: statusForGeneration,
  });
  const isGitConflict =
    gitStatus.data?.conflicted.some((file) => file.path === gitPath) ?? false;
  // Only untracked files need an absent baseline when Git returns no patch.
  // Staged adds already have a patch, or may match the All comparison's base.
  const liveNewFile = gitStatus.data?.untracked.includes(gitPath) ?? false;
  const oldPath = [...(gitStatus.data?.staged ?? []), ...(gitStatus.data?.unstaged ?? [])]
    .find(file => file.path === gitPath && file.oldPath)?.oldPath;

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
    ...(diffHistory ? [changesHistoryKey(diffHistory)] : []),
    ...(diffBaseBranch !== undefined ? [diffBaseBranch] : []),
  ]);

  const readQuery = useMemo<WorkspaceFileReadQuery>(
    () => ({
      cwd: cwd ?? "",
      path,
      contentRevision: contentRevision ?? 0,
      ...(skillSource ? { skillSource } : {}),
    }),
    [cwd, path, contentRevision, skillSource],
  );
  const diffQuery = useMemo<WorkspaceFileDiffQuery>(
    () => ({
      workspaceId: workspaceId ?? "",
      path: gitPath,
      ...(fileEditor ? { oldPath, diffScope: "all" as const, fullContext: editorPreferences.diffView } : { diffScope, diffSha, diffHistory, turnChatId, turnId }),
      ...(diffBaseBranch !== undefined ? { baseBranch: diffBaseBranch } : {}),
    }),
    [
      workspaceId,
      gitPath,
      oldPath,
      fileEditor,
      editorPreferences.diffView,
      diffScope,
      diffSha,
      diffHistory,
      diffBaseBranch,
      turnChatId,
      turnId,
    ],
  );
  // useSyncExternalStore gives the destination its exact cached snapshot in
  // the selection render. There is no component-local "loading reset" paint.
  const readSnapshot = useWorkspaceFileReadSnapshot(readQuery);
  const visible = useDocumentActive(active);
  const pendingPreview = usePendingFilePreview(cwd, path, active);
  const hasPendingPreview = pendingPreview !== null;
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
  const openLinkedFile = useOpenLinkedFileInWorkbench();
  const openPreviewLink = useCallback(
    (target: string) => openLinkedFile(cwd, target),
    [openLinkedFile, cwd],
  );
  const warmPreviewLink = useCallback(
    (target: string) => {
      if (cwd) prefetchWorkspaceFileRead(cwd, target);
    },
    [cwd],
  );
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
    if (!visible || !cwd) return;
    // Explicit pointer/workspace intent owns prefetch. Hidden viewers only
    // observe those results, including on a cold mount; fetching here would
    // bypass the speculative request bound while moving across Changes rows.
    if (!hasPendingPreview) void loadWorkspaceFileRead(readQuery, { maxAgeMs: 15_000 }).catch(() => {});
  }, [visible, cwd, readQuery, readKey, refreshKey, hasPendingPreview]);

  // Fetch the file's diff for the filter it was opened from: "all" = worktree vs
  // base (committed + uncommitted), "uncommitted" = worktree vs HEAD, "commit" =
  // that commit's own diff (vs its parent). Re-fetches on gitRefresh too; the
  // diff spinner shows only on a fresh file/scope (no flicker on live refresh).
  useEffect(() => {
    if (!active || !workspaceId) return;
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
    !pendingPreview &&
    diskResult?.path === path &&
    diskResult?.kind === "error" &&
    diskResult.error === "file no longer exists on disk";
  const result = pendingPreview ?? diskResult;
  const isDocument = fileMediaType(path)?.kind === "document";
  const DocumentPreview = /\.docx$/i.test(path) ? FileWordPreview : FilePdfPreview;
  const isText = result?.kind === "text" && !isDocument;
  const readLoading = !result && readSnapshot.loading;
  const readFailed = !result && !readSnapshot.loading && !!readSnapshot.error;
  const rawDiff = workspaceId ? (diffSnapshot.data ?? null) : "";
  const diffLoading = rawDiff === null && diffSnapshot.loading;
  const diffFailed = rawDiff === null && !diffLoading && !!diffSnapshot.error;
  useWorkbenchStatusSource(
    {
      active,
      error:
        hasPendingPreview ? null : readSnapshot.error ?? (result?.kind === "error" ? result.error : null),
      pending: !hasPendingPreview && (readSnapshot.loading || readSnapshot.refreshing),
      primary: true,
      hasContent: !!result && result.kind !== "error",
      retry: () => loadWorkspaceFileRead(readQuery, { force: true }),
    },
    JSON.stringify([cwd, path, "read"]),
  );
  useWorkbenchStatusSource(
    {
      active,
      error: workspaceId ? diffSnapshot.error : null,
      pending:
        !!workspaceId && (diffSnapshot.loading || diffSnapshot.refreshing),
      hasContent: rawDiff !== null,
      retry: () => loadWorkspaceFileDiff(diffQuery, { force: true }),
    },
    JSON.stringify([workspaceId, path, diffQuery]),
  );

  // The diff to render: the git patch if present; for a live-status-confirmed
  // new file opened from Changes — absent from `git diff` — synthesize an
  // all-additions patch from its contents. Never infer "new" from rawDiff ===
  // "": that is also the normal post-discard state of a tracked file. NOT for
  // commit scope, where an empty diff means the file isn't part of that commit.
  // Text-only, so a tracked binary's "Binary files … differ" never leaks in.
  const sourceBlocksTextDiff =
    result?.kind === "binary" || result?.kind === "image" || result?.kind === "video";
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
      diffScope !== "history" &&
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
    isText &&
    (diffScope === "commit" || diffScope === "history") &&
    !diffLoading &&
    rawDiff === "";

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
    diffIntent: diff === true || (fileEditor && editorPreferences.diffView),
    diffPendingOrAvailable: diffLoading || diffAvailable,
  });

  // Effective mode: the user's pick, else the entry-point default, clamped off
  // Diff only when there's nothing diff-related to show (purely derived — no
  // effect races, so a Changes click lands on Diff immediately).
  // A successful tracked discard bumps contentRevision: land in Edit even for
  // Markdown (whose ordinary All Files default is Preview), exactly matching
  // the post-discard workflow. A later explicit file-open clears the revision
  // marker and restores the entry point's normal default.
  const autoMode: ViewerMode = diff && !fileEditor
    ? "diff"
    : contentRevision
      ? "edit"
      : isMarkdown
        ? "preview"
        : "edit";
  // If the source disappeared but Git has a deletion patch, Diff is the only
  // meaningful surface — switch there even if Edit had been explicitly chosen.
  let mode: ViewerMode =
    missingDisposition === "review-diff" ? "diff" : (fileEditor && viewerMode === "diff" ? "edit" : viewerMode ?? autoMode);
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
  // After discarding, or marking viewed in the Changes host, open the next
  // change (directional sweep). Follows the active tab in Diff mode — since
  // the viewer IS the active File tab, the current file is "closed" by being
  // swapped out; null → stay (nothing left to review).
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
          diffHistory,
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
    diffHistory,
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
      // The Changes host walks on to the next change; a File tab stays on the
      // file it was asked to show, as unchecking already does.
      if (onOpenPath) advance();
    }
  }, [workspaceId, path, advance, onOpenPath]);
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
        forgetEditorDraft(targetScope, targetPath);
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

  const canCopy = isText && result.content != null;
  const isMedia = result?.kind === "image" || result?.kind === "video";

  // Local source editing also repairs conflicted Design metadata. In a cloud
  // workspace, agents author Design natively but people's Files edits to
  // Design paths stay refused by the engine (assertNoDesignPathWrites).
  const designReadOnly = result?.designPath === true && isCloudWorkspace(cwd);
  const sourceReadOnly = readOnly || designReadOnly;
  // A read-only view marks a Git conflict's blocks without actions and says
  // once where to resolve them (or which marker cannot be paired).
  const readOnlyConflicts = useMemo(() => {
    if (!sourceReadOnly || !isGitConflict || !sourceShown) return null;
    const parsed = parseMergeConflicts(result?.content ?? "");
    const broken = conflictMarkerNotice(parsed);
    if (!broken && !parsed.conflicts.length) return null;
    return {
      broken: !!broken,
      notice: broken ?? "Open the live editable file to resolve these conflicts.",
      rows: broken ? null : conflictRowsStyle(parsed),
    };
  }, [sourceReadOnly, isGitConflict, sourceShown, result?.content]);

  // Mode toggle: markdown → Preview/Edit (+ Diff when a diff is available); other
  // text → Edit (+ Diff). "Diff" stays available for notInCommit so the user can
  // see the "not part of this commit" explanation. A lone option renders no toggle.
  const modeOptions: ViewerMode[] = fileEditor
    ? isMarkdown ? ["preview", "edit"] : ["edit"]
    : isMarkdown
    ? diffAvailable
      ? ["diff", "preview", "edit"]
      : ["preview", "edit"]
    : diffAvailable
      ? ["diff", "edit"]
      : ["edit"];
  const showToggle = showModeToggle && isText && modeOptions.length > 1;

  // Changes hosts this row above its retained viewer deck and stable sidebar.
  const header = (
    <div
      data-testid="files-viewer-header"
      className={cn(
        "bg-bg1 flex min-h-9 shrink-0 items-center justify-between gap-x-2 gap-y-1 py-0.5 pr-1 pl-3",
        // In a pane too narrow for one row the controls wrap under the name
        // instead of clipping; a host's fixed toolbar keeps one row.
        headerContainer ? "h-full" : "flex-wrap",
        headerBorder && "border-border1 border-b",
      )}
    >
      <Inline gap={2} align="center" className="min-w-0">
        {headerLeading}
        <div
          data-testid="file-path-actions"
          className="flex min-w-0 items-center gap-1"
        >
          {path && <PathBreadcrumbs path={path} truncateFilename={isMedia || isDocument} />}
          {(isMedia || isDocument) && <span ref={setMediaActionsContainer} className="flex shrink-0 items-center gap-1" />}
          {canCopy && (
            <CodeBlockCopyButton
              text={result!.content ?? ""}
              className={WORKBENCH_TITLE_ACTION_CLS}
            />
          )}
          {sourceShown && editorConflicts && (
            <ConflictNavigator
              count={editorConflicts.count}
              shown={editorConflicts.shown}
              onPrevious={editorConflicts.previous}
              onNext={editorConflicts.next}
              disabled={!active}
            />
          )}
        </div>
      </Inline>
      <Inline gap={1} align="center" className="ml-auto shrink-0">
        {/* Viewed — only while a diff is on screen, the one place a file is
          reviewed. Dims its Changes-list row; the Changes host then moves on
          to the next change, a File tab stays on the file. */}
        {hasDiff && (diffShown || (fileEditor && editorPreferences.diffView)) && (
          <Checkbox
            checked={viewed}
            onChange={toggleViewed}
            label="Viewed"
            className="text-fg2 hover:text-fg1 h-7 shrink-0 items-center rounded-md px-1.5 [&>span[aria-hidden]]:mt-0"
          />
        )}
        {/* Discard — ONLY when opened from the All-changes filter on a file
          with uncommitted work (discardable) and a writable target. */}
        {discardable && !sourceReadOnly && (!fileMissing || diffAvailable) && (
          <Tooltip
            label={isNewFile ? "Delete file" : "Discard changes"}
          >
            <IconButton
              size="standard"
              label={isNewFile ? "Delete file" : "Discard changes"}
              onClick={() => setDiscardTarget(path)}
              disabled={discardingPath === path}
              aria-busy={discardingPath === path}
            >
              <Undo2 />
            </IconButton>
          </Tooltip>
        )}
        {/* Unified ⇄ split — only in Diff mode. */}
        {diffShown && !fileEditor && (
          <Tabs
            value={diffStyle}
            onValueChange={(value) => setDiffStyle(value as typeof diffStyle)}
          >
            <TabsList aria-label="Diff layout">
              {(
                [
                  ["unified", AlignJustify, "Unified view"],
                  ["split", Columns2, "Split view"],
                ] as const
              ).map(([style, Icon, label]) => (
                <Tooltip key={style} label={label}>
                  <TabsTrigger value={style} aria-label={label} className="w-6 px-0">
                    <Icon />
                  </TabsTrigger>
                </Tooltip>
              ))}
            </TabsList>
          </Tabs>
        )}
        {showToggle && (
          <Tabs
            value={mode}
            onValueChange={(value) => onViewerModeChange?.(value as ViewerMode)}
          >
            <TabsList aria-label="View">
              {modeOptions.map((v) => (
                <TabsTrigger key={v} value={v}>
                  {VIEWER_MODE_LABEL[
                    v === "edit" && (skillSource || parseContextAttachmentPath(path)) ? "code" : v
                  ]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
        {fileEditor && isText && !sourceReadOnly && (
          <FileEditorOptions key={editorKey} active={active}
            controls={currentEditorControls}
            canDiff={!!workspaceId}
            diffWaiting={isGitConflict}
            onDiffViewChange={() => onViewerModeChange?.("edit")} />
        )}
        {headerTrailing}
      </Inline>
    </div>
  );

  return (
    <WorkbenchTabStatusScope active={active}>
      <div ref={viewerRef} className="bg-bg1 flex h-full min-h-0 flex-col">
        {headerContainer === undefined ? (
          <WorkbenchTabToolbar>{header}</WorkbenchTabToolbar>
        ) : headerContainer ? (
          createPortal(header, headerContainer)
        ) : null}

        {/* Body row. Optional trailing content starts below the fixed header. */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            data-testid="files-viewer-body"
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
            aria-busy={readLoading || diffLoading || undefined}
          >
            {readFailed && !diffShown && <WorkbenchEmptyState type="files" message="Retry to load this file." />}
            {result?.kind === "binary" && !isDocument && !diffShown && (
              <Placeholder
                Icon={FileX2}
                text="Binary file — preview not available"
              />
            )}
            {isDocument && result && ["binary", "text"].includes(result.kind) && !diffShown && (
              result.media || result.blob || result.dataUrl ? <React.Suspense fallback={null}>
                <DocumentPreview key={JSON.stringify([tabId, readKey, result.media?.version])}
                  source={{ cwd, path, bytes: result.bytes, media: result.media, blob: result.blob, dataUrl: result.dataUrl }}
                  active={active} actionsContainer={mediaActionsContainer} />
              </React.Suspense> : !hasPendingPreview && <WorkbenchEmptyState type="files" message="Update the workspace runtime to preview this document." />
            )}
            {result?.kind === "too-large" && !diffShown && (
              <Placeholder
                Icon={FileX2}
                text={`File too large to preview (${(result.bytes / 1_000_000).toFixed(1)} MB)`}
              />
            )}
            {result?.kind === "error" && !fileMissing && !diffShown && (
              <WorkbenchEmptyState type="files" message="Retry to load this file." />
            )}
            {missingDisposition === "show-missing" && !diffShown && (
              <Placeholder Icon={FileX2} text="file no longer exists on disk" />
            )}
            {(result?.kind === "image" || result?.kind === "video") && !diffShown && (
              result.dataUrl || result.media || hasPendingPreview ? (
                <FileMediaPreview key={JSON.stringify([tabId, readKey])} kind={result.kind}
                  sourceIdentity={hasPendingPreview ? readKey : undefined}
                  cwd={cwd}
                  source={result.dataUrl} mediaSource={result.media && cwd ? { cwd, bytes: result.bytes, media: result.media } : undefined}
                  path={path} active={active} actionsContainer={mediaActionsContainer} />
              ) : <Placeholder Icon={ImageOff} text="Media unavailable" />
            )}
            {diffShown &&
              (notInCommit ? (
                <Placeholder
                  Icon={FileQuestion}
                  text={`${baseOf(path)} isn’t part of this commit`}
                />
              ) : diffFailed ? (
                <WorkbenchEmptyState type="files" message="Retry to load this file." />
              ) : diffLoading ? (
                <div className="h-full" aria-busy="true" />
              ) : (
                <DiffView
                  path={path}
                  patch={diffPatch}
                  diffStyle={fileEditor ? "unified" : diffStyle}
                  scrollKey={diffScrollKey}
                  review={review}
                  active={active}
                />
              ))}
            {previewShown && (
              <div
                ref={previewScrollRef}
                className="h-full overflow-x-hidden overflow-y-auto px-5 py-4"
              >
                <MarkdownPreview
                  markdown={result?.content ?? ""}
                  path={path}
                  onOpenFile={openPreviewLink}
                  onWarmFile={warmPreviewLink}
                />
              </div>
            )}
            {sourceShown && sourceReadOnly && (
              <div className="flex h-full min-h-0 flex-col">
                {designReadOnly && (
                  <div className="text-fg3 bg-bg2 border-border1 shrink-0 border-b px-5 py-2 text-xs">
                    Edit this cloud Design source through the Design tools.
                  </div>
                )}
                <div className="flex min-h-0 flex-1 flex-col">
                  {readOnlyConflicts?.notice && !designReadOnly && (
                    <MessageRow
                      bar
                      role="status"
                      tone={readOnlyConflicts.broken ? "error" : "neutral"}
                    >
                      {readOnlyConflicts.notice}
                    </MessageRow>
                  )}
                  <div className="min-h-0 flex-1">
                    <ReadOnlySource
                      path={path}
                      content={result?.content ?? ""}
                      scrollKey={JSON.stringify([scrollKeyBase, "source"])}
                      review={review}
                      active={active}
                      conflictRows={readOnlyConflicts?.rows}
                    />
                  </div>
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
                aria-hidden={!sourceShown || !active || undefined}
                {...(!sourceShown || !active ? { inert: "" } : {})}
              >
                <SourceEditor
                  key={`${cwd}::${path}::${contentRevision ?? 0}`}
                  editorId={tabId}
                  cwd={cwd ?? ""}
                  path={path}
                  content={result?.content ?? ""}
                  offscreen={!sourceShown || !active}
                  active={active}
                  autoSave={fileEditor && editorPreferences.autoSave}
                  editableDiffQuery={fileEditor && editorPreferences.diffView && workspaceId ? diffQuery : undefined}
                  isNewFile={liveNewFile}
                  refreshKey={refreshKey}
                  onControlsChange={fileEditor ? onEditorControls : undefined}
                  review={review}
                  isGitConflict={isGitConflict}
                />
              </div>
            )}
          </div>
          {bodyTrailing}
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
    </WorkbenchTabStatusScope>
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

/** Native reviewed viewers own one scroll surface and restore its exact key. */
function DiffView({
  path,
  patch,
  diffStyle,
  scrollKey,
  review,
  active,
}: {
  path: string;
  patch: string;
  diffStyle: "unified" | "split";
  scrollKey?: string;
  review: CodeReviewController;
  active: boolean;
}) {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  useScrollMemory(scroller, scrollKey ?? null);
  return (
    <ReviewDiffView
      path={path}
      patch={patch}
      diffStyle={diffStyle}
      review={review}
      active={active}
      onScroller={setScroller}
    />
  );
}

function ReadOnlySource({
  path,
  content,
  scrollKey,
  review,
  active,
  conflictRows,
}: {
  path: string;
  content: string;
  scrollKey?: string;
  review: CodeReviewController;
  active: boolean;
  conflictRows?: string | null;
}) {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  useScrollMemory(scroller, scrollKey ?? null);
  return (
    <ReviewSourceView
      path={path}
      content={content}
      review={review}
      active={active}
      onScroller={setScroller}
      conflictRows={conflictRows}
    />
  );
}

// ── Shared placeholder ─────────────────────────────────────

/** Couldn't load, No preview and the rest: the one shared empty state. */
function Placeholder({
  Icon,
  text,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  text: string;
}) {
  return <EmptyState icon={Icon}>{text}</EmptyState>;
}
