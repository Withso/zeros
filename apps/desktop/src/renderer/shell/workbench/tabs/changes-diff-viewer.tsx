import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewItem,
} from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  AlignJustify,
  Columns2,
  ChevronDown,
  Copy,
  Check,
  CircleAlert,
  File,
  Files,
  ChevronsDownUp,
  ChevronsUpDown,
} from "lucide-react";
import { Button, Checkbox, Tooltip } from "@/renderer/shared/ui/primitives";
import { FileTypeIcon } from "@/renderer/features/agent/composer-editor/file-type-icon";
import { useCodeTheme } from "@/renderer/shared/theme/use-code-theme";
import { finishDiffRender } from "@/renderer/shared/theme/diff-theme";
import { savedScrollOffset, useScrollMemory } from "../../scroll-memory";
import {
  loadWorkspaceFileRead,
  useWorkspaceFileReadSnapshot,
  type WorkspaceFileDiffQuery,
} from "../../workspace-file-data-cache";
import type { ChangedFile } from "./changes-parse";
import { setDiffStyle, useDiffStyle } from "./diff-style-store";
import {
  hashString,
  isFileViewed,
  setFileViewed,
  useViewedVersion,
} from "./use-viewed-files";
import {
  changesDiffDataKey,
  changesDiffDataWeight,
  initialChangesDiff,
  loadChangesDiffData,
  peekChangesDiffData,
  placeholderFileContents,
  type ChangesDiffData,
} from "./changes-diff-data";
import { diffViewVersion } from "./diff-view-version";
import { cn } from "@/renderer/shared/ui/cn";
import { changesDiffOptions } from "./changes-diff-options";
import { useCodeReview } from "@/renderer/features/code-review/use-code-review";
import { useInlineReview } from "@/renderer/features/code-review/use-inline-review";
import {
  reviewAnnotationVersion,
  reviewUnplacedThreads,
  type ReviewAnnotationPayload,
} from "@/renderer/features/code-review/review-annotations";
import { retainReviewCodeViewItem } from "@/renderer/features/code-review/review-code-view-items";
import { ReviewUnplacedThreads } from "@/renderer/features/code-review/review-annotation-view";
import { ReviewFeedback } from "@/renderer/features/code-review/review-feedback";
import {
  labelReviewGutter,
  REVIEW_GUTTER_CSS,
} from "@/renderer/features/code-review/review-pierre-options";
import type { CodeReviewExternalSource } from "@/renderer/features/code-review/review-thread-model";
import {
  liveReviewHunkSource,
  reviewComparisonForScope,
  type ReviewLiveHunkSource,
} from "@/renderer/features/code-review/review-hunk-model";
import { reviewContentRevision } from "@/renderer/features/code-review/review-anchors";
import { useOpenFileInWorkbench } from "../use-open-file";

interface Props {
  active: boolean;
  files: ChangedFile[];
  selected: string | null;
  selectionRequest: number;
  workspaceId: string;
  cwd: string;
  ownerKey: string;
  refreshKey: number;
  presentation: "all" | "single";
  onPresentationChange: (mode: "all" | "single") => void;
  queryForFile: (file: ChangedFile) => WorkspaceFileDiffQuery;
  toolbarContainer: HTMLElement | null;
  reviewExternal?: CodeReviewExternalSource;
  /** Only a caller displaying a confirmed published PR-head diff supplies this. */
  reviewPrRevision?: string;
  readOnly?: boolean;
}

const initialData = new WeakMap<ChangedFile, ChangesDiffData>();
function initial(file: ChangedFile) {
  let data = initialData.get(file);
  if (!data) {
    data = initialChangesDiff(file);
    initialData.set(file, data);
  }
  return data;
}

function liveHunkSignature(
  cwd: string,
  query: WorkspaceFileDiffQuery,
  file: ChangedFile,
  refreshKey: number,
): string {
  return JSON.stringify([
    cwd,
    query.workspaceId,
    query.diffScope,
    file.path,
    file.hash ?? hashString(file.patch),
    file.status,
    refreshKey,
  ]);
}

/** One Pierre virtualizer owns all visible files and lines. Switching to one
 * file changes its items, not the comparison or the per-file folding state. */
export function ChangesDiffViewer({
  active,
  files,
  selected,
  selectionRequest,
  workspaceId,
  cwd,
  ownerKey,
  refreshKey,
  presentation,
  onPresentationChange,
  queryForFile,
  toolbarContainer,
  reviewExternal,
  reviewPrRevision,
  readOnly = false,
}: Props) {
  const view = useRef<CodeViewHandle<ReviewAnnotationPayload, undefined>>(null);
  const shown = useMemo(
    () =>
      presentation === "single"
        ? files.filter((file) => file.path === selected)
        : files,
    [files, presentation, selected],
  );
  const shownPaths = useMemo(() => shown.map((file) => file.path), [shown]);
  const review = useCodeReview({
    cwd,
    workspaceId,
    active,
    refreshKey,
    external: reviewExternal,
  });
  const inlineReview = useInlineReview(review, active, shownPaths);
  const { annotationsForDiff, snapshotFor } = inlineReview;
  const retainedReviewItems = useMemo(
    () => new Map<string, CodeViewItem<ReviewAnnotationPayload>>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Pierre's prepared items must not cross a retained comparison owner
    [ownerKey],
  );
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [hunkSources, setHunkSources] = useState(
    new Map<
      string,
      { signature: string; source: ReviewLiveHunkSource | undefined }
    >(),
  );
  const publishHunkSource = useCallback(
    (
      file: ChangedFile,
      signature: string,
      source: ReviewLiveHunkSource | undefined,
    ) => {
      setHunkSources((old) => {
        const existing = old.get(file.path);
        if (
          existing?.signature === signature &&
          existing.source?.contentRevision === source?.contentRevision &&
          existing.source?.patch === source?.patch
        )
          return old;
        const next = new Map(old);
        next.delete(file.path);
        next.set(file.path, { signature, source });
        while (next.size > 96) next.delete(next.keys().next().value!);
        return next;
      });
    },
    [],
  );
  const [folds, setFolds] = useState({
    all: false,
    exceptions: new Set<string>(),
  });
  const [data, setData] = useState(
    new Map<
      string,
      { signature: string; key: string; value: ChangesDiffData; weight: number }
    >(),
  );
  const theme = useCodeTheme();
  const diffStyle = useDiffStyle();
  const viewedVersion = useViewedVersion();
  const scrollKey = JSON.stringify([ownerKey, presentation]);
  const restoringPosition = useRef(savedScrollOffset(scrollKey) !== undefined);
  const lastNavigation = useRef<{ selected: string; request: number } | null>(
    null,
  );
  useScrollMemory(scroller, scrollKey);
  const collapsed = useCallback(
    (path: string) => folds.all !== folds.exceptions.has(path),
    [folds],
  );
  const toggle = useCallback(
    (path: string) =>
      setFolds((old) => {
        const exceptions = new Set(old.exceptions);
        if (exceptions.has(path)) exceptions.delete(path);
        else exceptions.add(path);
        return { all: old.all, exceptions };
      }),
    [],
  );
  const byPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );
  useEffect(() => {
    setFolds((old) => {
      const exceptions = new Set(
        [...old.exceptions].filter((path) => byPath.has(path)),
      );
      return exceptions.size === old.exceptions.size
        ? old
        : { ...old, exceptions };
    });
  }, [byPath]);
  const publish = useCallback(
    (file: ChangedFile, key: string, value: ChangesDiffData) => {
      setData((old) => {
        if (
          old.get(file.path)?.key === key &&
          old.get(file.path)?.value === value
        )
          return old;
        const next = new Map(old);
        next.delete(file.path);
        const weight = changesDiffDataWeight(value);
        next.set(file.path, {
          signature: file.hash ?? hashString(file.patch),
          key,
          value,
          weight,
        });
        // Full file contents are bounded independently of the virtual DOM. Keep
        // the newest entry even when one exceptional file exceeds the budget.
        let retainedWeight = [...next.values()].reduce(
          (total, entry) => total + entry.weight,
          0,
        );
        while (
          next.size > 1 &&
          (next.size > 96 || retainedWeight > 32 * 1024 * 1024)
        ) {
          const oldest = next.keys().next().value!;
          retainedWeight -= next.get(oldest)!.weight;
          next.delete(oldest);
        }
        return next;
      });
    },
    [],
  );
  const items = useMemo<CodeViewItem<ReviewAnnotationPayload>[]>(
    () =>
      shown.map((file) => {
        const entry = data.get(file.path);
        const current =
          entry?.signature === (file.hash ?? hashString(file.patch))
            ? entry
            : undefined;
        const seed = initial(file);
        // A remounted summary row must reuse its resolved diff immediately;
        // rendering a loading placeholder changes the virtual scroll geometry.
        const key = !file.patch
          ? changesDiffDataKey(queryForFile(file), file, refreshKey)
          : undefined;
        const cached = key ? peekChangesDiffData(key) : undefined;
        const value = cached ?? current?.value;
        const fileDiff = value?.fileDiff ?? seed.fileDiff;
        const message = value?.message ?? seed.message;
        const revision = reviewContentRevision(
          file.patch ||
            value?.patch ||
            JSON.stringify([fileDiff?.additionLines, fileDiff?.deletionLines]),
        );
        const live = hunkSources.get(file.path);
        const hunkSource =
          live?.signature ===
          liveHunkSignature(cwd, queryForFile(file), file, refreshKey)
            ? live.source
            : undefined;
        const annotations = fileDiff
          ? annotationsForDiff(
              file.path,
              {
                kind: "diff",
                path: file.path,
                revision,
                fileDiff,
                confirmedRevision: reviewPrRevision,
              },
              hunkSource,
            )
          : undefined;
        const common = {
          id: file.path,
          collapsed: collapsed(file.path),
          version: diffViewVersion(
            `${revision}:${active}:${collapsed(file.path)}:${annotations ? reviewAnnotationVersion(annotations) : ""}`,
          ),
        };
        // Pierre asserts a collapsed re-render commits the exact object it
        // prepared layout for, so placeholder cards must keep one identity.
        return retainReviewCodeViewItem(
          retainedReviewItems,
          fileDiff
            ? { ...common, type: "diff", fileDiff, annotations }
            : {
                ...common,
                type: "file",
                file: placeholderFileContents(
                  file.path,
                  message ?? "No textual changes",
                ),
              },
        );
      }),
    [
      shown,
      data,
      collapsed,
      queryForFile,
      refreshKey,
      annotationsForDiff,
      reviewPrRevision,
      retainedReviewItems,
      hunkSources,
      cwd,
      active,
    ],
  );
  useEffect(() => {
    const paths = new Set(shown.map((file) => file.path));
    for (const path of retainedReviewItems.keys())
      if (!paths.has(path)) retainedReviewItems.delete(path);
  }, [shown, retainedReviewItems]);
  const unplacedThreads = useMemo(
    () =>
      items.flatMap((item) =>
        item.type === "diff"
          ? reviewUnplacedThreads(snapshotFor(item.id)!, review.threads)
          : review.threads
              .filter((thread) => thread.anchor.path === item.id)
              .map((thread) => ({ thread, state: "unavailable" as const })),
      ),
    [items, review.threads, snapshotFor],
  );
  const loadDiffFiles = useCallback(
    async (fileDiff: FileDiffMetadata) => {
      const file = byPath.get(fileDiff.name);
      if (!file)
        throw new Error(`Unable to find ${fileDiff.name} in this comparison`);
      const query = queryForFile(file);
      const key = changesDiffDataKey(query, file, refreshKey);
      const value =
        peekChangesDiffData(key) ??
        (await loadChangesDiffData(key, query, file, cwd));
      if (!value.loadedFiles) {
        publish(file, key, value);
        throw new Error(
          value.notice ??
            value.message ??
            `Full file context is unavailable for ${file.path}`,
        );
      }
      return value.loadedFiles;
    },
    [byPath, queryForFile, refreshKey, cwd, publish],
  );
  const options = useMemo(() => {
    const shared = changesDiffOptions<ReviewAnnotationPayload>({
      diffStyle,
      codeThemeId: theme,
    });
    return {
      ...shared,
      ...inlineReview.options,
      unsafeCSS: `${shared.unsafeCSS ?? ""}\n${REVIEW_GUTTER_CSS}`,
      onPostRender: (node: HTMLElement) => {
        finishDiffRender(node);
        labelReviewGutter(node);
      },
      stickyHeaders: true,
      hunkSeparators: "line-info" as const,
      loadDiffFiles,
    };
  }, [diffStyle, theme, loadDiffFiles, inlineReview.options]);
  useLayoutEffect(() => {
    if (!active || !selected || !scroller || !byPath.has(selected)) return;
    const previous = lastNavigation.current;
    if (
      previous?.selected === selected &&
      previous.request === selectionRequest
    )
      return;
    lastNavigation.current = { selected, request: selectionRequest };
    // Reactivating a retained surface is not navigation. On remount, let keyed
    // scroll memory restore the reader; consume only new file/open intents.
    if (!previous && restoringPosition.current) return;
    setFolds((old) => {
      const isCollapsed = old.all !== old.exceptions.has(selected);
      if (!isCollapsed) return old;
      const exceptions = new Set(old.exceptions);
      if (old.all) exceptions.add(selected);
      else exceptions.delete(selected);
      return { ...old, exceptions };
    });
    view.current?.scrollTo({ type: "item", id: selected, align: "start" });
  }, [active, selected, selectionRequest, scroller, byPath]);
  const allCollapsed =
    files.length > 0 && files.every((file) => collapsed(file.path));
  const renderHeader = useCallback(
    (item: CodeViewItem<ReviewAnnotationPayload>) => {
      void viewedVersion;
      const file = byPath.get(item.id);
      if (!file) return null;
      const entry = data.get(file.path);
      return (
        <ChangesDiffHeader
          file={file}
          cwd={cwd}
          workspaceId={workspaceId}
          query={queryForFile(file)}
          refreshKey={refreshKey}
          active={active}
          collapsed={collapsed(file.path)}
          onToggle={() => toggle(file.path)}
          onData={publish}
          hydrateOnMount={initial(file).message === "Loading diff…"}
          notice={entry?.value.notice}
          viewed={isFileViewed(workspaceId, file.path)}
          patch={file.patch || entry?.value.patch || ""}
          readOnly={readOnly || !!reviewPrRevision}
          onHunkSource={publishHunkSource}
        />
      );
      // Viewed is external state. Reconcile the existing header portals on updates.
    },
    [
      byPath,
      data,
      cwd,
      workspaceId,
      queryForFile,
      refreshKey,
      active,
      collapsed,
      toggle,
      publish,
      viewedVersion,
      readOnly,
      reviewPrRevision,
      publishHunkSource,
    ],
  );

  return (
    <>
      {active &&
        toolbarContainer &&
        createPortal(
          <div className="flex h-full items-center justify-end gap-1">
            <div className="bg-bg2 flex items-center rounded-md p-0.5">
              {(["unified", "split"] as const).map((style) => (
                <Tooltip
                  key={style}
                  label={style === "unified" ? "Unified diff" : "Split diff"}
                >
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={
                      style === "unified" ? "Unified diff" : "Split diff"
                    }
                    aria-pressed={diffStyle === style}
                    className={cn(
                      // 24px segment inside the 2px-inset track above.
                      "text-fg2 size-6",
                      diffStyle === style && "bg-bg1 text-fg1",
                    )}
                    onClick={() => setDiffStyle(style)}
                  >
                    {style === "unified" ? (
                      <AlignJustify className="size-3.5" />
                    ) : (
                      <Columns2 className="size-3.5" />
                    )}
                  </Button>
                </Tooltip>
              ))}
            </div>
            <Tooltip
              label={allCollapsed ? "Expand all diffs" : "Collapse all diffs"}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!files.length}
                aria-label={
                  allCollapsed ? "Expand all diffs" : "Collapse all diffs"
                }
                onClick={() =>
                  setFolds({ all: !allCollapsed, exceptions: new Set() })
                }
              >
                {allCollapsed ? (
                  <ChevronsUpDown className="size-3.5" />
                ) : (
                  <ChevronsDownUp className="size-3.5" />
                )}
              </Button>
            </Tooltip>
            <Tooltip
              label={
                presentation === "all"
                  ? "Show one file at a time"
                  : "Show all file diffs"
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={
                  presentation === "all"
                    ? "Show one file at a time"
                    : "Show all file diffs"
                }
                aria-pressed={presentation === "all"}
                onClick={() =>
                  onPresentationChange(
                    presentation === "all" ? "single" : "all",
                  )
                }
              >
                {presentation === "all" ? (
                  <Files className="size-3.5" />
                ) : (
                  <File className="size-3.5" />
                )}
              </Button>
            </Tooltip>
          </div>,
          toolbarContainer,
        )}
      <div
        className="absolute inset-0 min-h-0 focus-visible:outline-none"
        tabIndex={active ? 0 : -1}
        aria-label="Changes diff. Press Command or Control Shift M to comment on lines."
        onKeyDown={(event) =>
          inlineReview.onKeyDown(
            event,
            selected ?? shown[0]?.path,
            (selection) => view.current?.setSelectedLines(selection),
          )
        }
      >
        <CodeView
          ref={view}
          containerRef={setScroller}
          items={items}
          options={options}
          renderCustomHeader={renderHeader}
          renderAnnotation={inlineReview.renderAnnotation}
          renderCodeViewFooter={() => (
            <>
              {inlineReview.issue && (
                <p
                  role="status"
                  className="text-fg3 px-3 py-2 font-sans text-xs"
                >
                  {inlineReview.issue}
                </p>
              )}
              <ReviewUnplacedThreads
                entries={unplacedThreads}
                review={review}
                active={active}
                showPath
              />
              <ReviewFeedback review={review} />
            </>
          )}
          className="absolute inset-0 min-h-0 overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        />
      </div>
    </>
  );
}

function ChangesDiffHeader({
  file,
  query,
  cwd,
  workspaceId,
  refreshKey,
  active,
  collapsed,
  onToggle,
  onData,
  hydrateOnMount,
  notice,
  viewed,
  patch,
  readOnly,
  onHunkSource,
}: {
  file: ChangedFile;
  query: WorkspaceFileDiffQuery;
  cwd: string;
  workspaceId: string;
  refreshKey: number;
  active: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onData: (file: ChangedFile, key: string, value: ChangesDiffData) => void;
  hydrateOnMount: boolean;
  notice?: string;
  viewed: boolean;
  patch: string;
  readOnly: boolean;
  onHunkSource: (
    file: ChangedFile,
    signature: string,
    source: ReviewLiveHunkSource | undefined,
  ) => void;
}) {
  const key = changesDiffDataKey(query, file, refreshKey);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const openFile = useOpenFileInWorkbench();
  const readQuery = useMemo(() => ({ cwd, path: file.path }), [cwd, file.path]);
  const readSnapshot = useWorkspaceFileReadSnapshot(readQuery);
  const supportsHunks =
    !readOnly &&
    !file.binary &&
    file.status !== "conflicted" &&
    !!reviewComparisonForScope(query.diffScope);
  useEffect(() => {
    if (active && !collapsed && supportsHunks)
      void loadWorkspaceFileRead(readQuery, { maxAgeMs: 15_000 }).catch(
        () => {},
      );
  }, [active, collapsed, supportsHunks, readQuery, refreshKey]);
  const hunkSource = useMemo(
    () =>
      supportsHunks
        ? liveReviewHunkSource({
            cwd,
            path: file.path,
            patch,
            scope: query.diffScope,
            read: readSnapshot.data,
            deleted: file.status === "deleted",
            untracked: file.status === "untracked" || file.isNewFile,
          })
        : undefined,
    [
      supportsHunks,
      cwd,
      file.path,
      file.status,
      file.isNewFile,
      patch,
      query.diffScope,
      readSnapshot.data,
    ],
  );
  const hunkSignature = liveHunkSignature(cwd, query, file, refreshKey);
  useEffect(() => {
    onHunkSource(file, hunkSignature, hunkSource);
  }, [onHunkSource, file, hunkSignature, hunkSource]);
  const latest = useRef({ file, query, cwd, onData });
  latest.current = { file, query, cwd, onData };
  const load = useCallback(async () => {
    const args = latest.current;
    const value =
      peekChangesDiffData(key) ??
      (await loadChangesDiffData(key, args.query, args.file, args.cwd));
    args.onData(args.file, key, value);
    return value;
  }, [key]);
  useEffect(() => {
    if (!active || collapsed || file.binary || !hydrateOnMount) return;
    let cancelled = false;
    setError(null);
    void load().catch((error) => {
      if (!cancelled)
        setError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [active, collapsed, file.binary, hydrateOnMount, load]);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <div
      data-testid="changes-diff-header"
      data-file-path={file.path}
      className="group/diff-header bg-bg1 border-border1 text-fg2 flex h-9 min-w-0 items-center gap-2 border-b px-2 font-sans text-xs"
    >
      <Tooltip
        label={collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative shrink-0 hover:bg-transparent [&_svg]:size-3.5"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${file.path}`}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span className="flex items-center justify-center group-hover/diff-header:opacity-0 group-has-[:focus-visible]/diff-header:opacity-0">
            <FileTypeIcon name={file.path} size={14} />
          </span>
          <ChevronDown
            className={cn(
              "absolute opacity-0 group-hover/diff-header:opacity-100 group-has-[:focus-visible]/diff-header:opacity-100",
              collapsed && "-rotate-90",
            )}
          />
        </Button>
      </Tooltip>
      <button
        className="hover:text-fg1 min-w-0 truncate text-left"
        onClick={onToggle}
        title={
          file.oldPath && file.oldPath !== file.path
            ? `${file.oldPath} → ${file.path}`
            : file.path
        }
      >
        {file.path}
      </button>
      <span className="flex shrink-0 gap-1 tabular-nums">
        <span className="text-green-primary">+{file.additions}</span>
        <span className="text-red-primary">−{file.deletions}</span>
      </span>
      {notice && (
        <Tooltip label={notice}>
          <CircleAlert
            aria-label={notice}
            className="text-yellow-primary size-3.5 shrink-0"
          />
        </Tooltip>
      )}
      {file.status === "conflicted" && (
        <Button
          variant="ghost"
          disabled={!active}
          onClick={() => openFile(file.path, { viewerMode: "edit" })}
        >
          Resolve conflicts
        </Button>
      )}
      <Tooltip label="Copy file contents">
        <Button
          size="icon-sm"
          variant="ghost"
          className="pointer-events-none shrink-0 opacity-0 group-hover/diff-header:pointer-events-auto group-hover/diff-header:opacity-100 group-has-[:focus-visible]/diff-header:pointer-events-auto group-has-[:focus-visible]/diff-header:opacity-100 hover:bg-transparent [&_svg]:size-3"
          aria-label={`Copy ${file.path}`}
          disabled={file.binary}
          onClick={() => {
            const immediate = initial(file).copyText;
            void (
              immediate === undefined
                ? load().then((value) => {
                    if (value.copyText === undefined)
                      throw new Error(
                        "File content is unavailable for this change",
                      );
                    return value.copyText;
                  })
                : Promise.resolve(immediate)
            )
              .then((copyText) => navigator.clipboard.writeText(copyText))
              .then(() => setCopied(true))
              .catch((error) =>
                setError(
                  error instanceof Error ? error.message : String(error),
                ),
              );
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </Tooltip>
      {error && (
        <Tooltip label={error}>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Retry ${file.path}`}
            onClick={() => {
              setError(null);
              void load().catch((error) => setError(String(error)));
            }}
          >
            <span className="text-red-primary">Retry diff</span>
          </Button>
        </Tooltip>
      )}
      <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5">
        <Checkbox
          checked={viewed}
          aria-label={`Viewed ${file.path}`}
          onChange={() =>
            setFileViewed(
              workspaceId,
              file.path,
              !viewed,
              file.hash ?? hashString(file.patch),
            )
          }
        />
        Viewed
      </label>
    </div>
  );
}
