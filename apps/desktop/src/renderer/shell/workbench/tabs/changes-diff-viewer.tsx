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
import { savedScrollOffset, useScrollMemory } from "../../scroll-memory";
import type { WorkspaceFileDiffQuery } from "../../workspace-file-data-cache";
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
  type ChangesDiffData,
} from "./changes-diff-data";
import { diffViewVersion } from "./diff-view-version";
import { cn } from "@/renderer/shared/ui/cn";
import { changesDiffOptions } from "./changes-diff-options";

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
}: Props) {
  const view = useRef<CodeViewHandle<undefined, undefined>>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
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
  const shown = useMemo(
    () =>
      presentation === "single"
        ? files.filter((file) => file.path === selected)
        : files,
    [files, presentation, selected],
  );
  const items = useMemo<CodeViewItem<undefined>[]>(
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
        const common = {
          id: file.path,
          collapsed: collapsed(file.path),
          version: diffViewVersion(
            `${file.hash ?? hashString(file.patch)}:${cached ? key : (current?.key ?? "partial")}:${collapsed(file.path)}`,
          ),
        };
        return fileDiff
          ? { ...common, type: "diff", fileDiff }
          : {
              ...common,
              type: "file",
              file: {
                name: file.path,
                contents: message ?? "No textual changes",
                lang: "text",
              },
            };
      }),
    [shown, data, collapsed, queryForFile, refreshKey],
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
  const options = useMemo(
    () => ({
      ...changesDiffOptions({ diffStyle, codeThemeId: theme }),
      stickyHeaders: true,
      hunkSeparators: "line-info" as const,
      loadDiffFiles,
    }),
    [diffStyle, theme, loadDiffFiles],
  );
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
    (item: CodeViewItem<undefined>) => {
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
                      "text-fg2",
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
      <CodeView
        ref={view}
        containerRef={setScroller}
        items={items}
        options={options}
        renderCustomHeader={renderHeader}
        className="absolute inset-0 min-h-0 overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      />
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
}) {
  const key = changesDiffDataKey(query, file, refreshKey);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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
