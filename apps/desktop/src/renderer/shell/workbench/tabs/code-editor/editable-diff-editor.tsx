import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
} from "react";
import {
  DEFAULT_CODE_VIEW_LAYOUT,
  parseDiffFromFile,
  type CodeViewItem,
  type FileContents,
} from "@pierre/diffs";
import {
  Editor,
  EditStateManager,
  type EditorFactory,
} from "@pierre/diffs/edit";
import { CodeView, EditProvider, type CodeViewHandle } from "@pierre/diffs/react";
import { isNativeEditHistoryTarget, registerEditHistory } from "@/renderer/shared/ui/edit-history";
import { useCodeTheme } from "@/renderer/shared/theme/use-code-theme";
import {
  NEW_FILE_DIFF_CSS,
  zerosCodeViewOptions,
} from "@/renderer/shared/theme/diff-theme";
import { useWorkbenchStatusSource } from "../../tab-status";
import { useScrollMemory } from "../../../scroll-memory";
import {
  loadWorkspaceFileDiff,
  useWorkspaceFileDiffSnapshot,
  workspaceFileDiffKey,
  type WorkspaceFileDiffQuery,
} from "../../../workspace-file-data-cache";
import { hashString } from "../use-viewed-files";
import {
  EditableDiffUnavailable,
  editableDiffBase,
  withEditableContext,
  type EditableDiffUnavailableReason,
} from "./editable-diff-model";
import { setFileEditorPreferences } from "./editor-preferences";
import { FileDiff, FileMinus, FileXCorner } from "lucide-react";
import { Button } from "@/renderer/shared/ui/primitives/button";
import { EmptyState } from "@/renderer/shared/ui/layout/empty-state";

/** A comparison that can't become an editor says so in the body, with the way
 *  out; only a partial read offers Retry, the one case a reload can fix. */
const UNAVAILABLE: Record<
  EditableDiffUnavailableReason,
  { icon: ElementType; message: string }
> = {
  "too-large": { icon: FileXCorner, message: "This diff is too large to edit here." },
  binary: { icon: FileXCorner, message: "Binary files can’t be edited in Diff view." },
  deleted: { icon: FileMinus, message: "This file is deleted in this comparison." },
  partial: { icon: FileDiff, message: "Diff view needs the whole file to edit it." },
};

const createEditor: EditorFactory<undefined, undefined> = (
  type,
  options,
  key,
) => new Editor(type, { ...options, ownsVerticalViewport: true }, key);

interface EditableDiffEditorProps {
  query: WorkspaceFileDiffQuery;
  value: string;
  savedContent: string;
  isNewFile: boolean;
  /** Changes only on an external replacement or explicit discard. */
  revision: number;
  refreshKey: number;
  active: boolean;
  onChange: (value: string) => void;
  onSave: (value: string) => void;
  scrollMemoryKey: string;
}

export function EditableDiffEditor(props: EditableDiffEditorProps) {
  const { query, savedContent, isNewFile, active, refreshKey } = props;
  const completeQuery = useMemo(
    () => ({ ...query, fullContext: true }),
    [query],
  );
  const snapshot = useWorkspaceFileDiffSnapshot(completeQuery);
  useEffect(() => {
    if (active)
      void loadWorkspaceFileDiff(completeQuery, { maxAgeMs: 15_000 }).catch(
        () => {},
      );
  }, [active, completeQuery, refreshKey]);
  // The patch owns the baseline. A save echo changing the current source must
  // not move that baseline or replace Pierre's live session before Git replies.
  const baseline = useMemo(() => {
    if (snapshot.data === undefined) return null;
    try {
      return {
        oldFile: editableDiffBase(
          snapshot.data,
          query.path,
          savedContent,
          isNewFile,
        ),
        error: null,
      };
    } catch (error) {
      return { oldFile: null, error };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- savedContent is fallback text only when a new complete comparison arrives
  }, [snapshot.data, snapshot.updatedAt, query.path, isNewFile]);
  const unavailable =
    baseline?.error instanceof EditableDiffUnavailable ? baseline.error : null;
  const retry = () => loadWorkspaceFileDiff(completeQuery, { force: true });
  useWorkbenchStatusSource(
    {
      active,
      // The body owns a refusal; the banner keeps read failures.
      error: unavailable ? null : (baseline?.error ?? snapshot.error),
      pending: snapshot.loading || snapshot.refreshing,
      hasContent: (!!baseline && !baseline.error) || !!unavailable,
      retry,
    },
    workspaceFileDiffKey(completeQuery),
  );
  if (unavailable) {
    const { icon, message } = UNAVAILABLE[unavailable.reason];
    return (
      <EmptyState
        icon={icon}
        action={
          <div className="flex items-center gap-2">
            <Button
              size="compact"
              onClick={() => setFileEditorPreferences({ diffView: false })}
            >
              Turn off Diff view
            </Button>
            {unavailable.reason === "partial" ? (
              <Button variant="ghost" size="compact" onClick={() => void retry()}>
                Retry
              </Button>
            ) : null}
          </div>
        }
      >
        {message}
      </EmptyState>
    );
  }
  if (!baseline || baseline.error)
    return <div className="h-full" aria-busy={snapshot.loading || undefined} />;
  return (
    <EditableDiffSession
      key={JSON.stringify([
        query.path,
        props.revision,
        baseline.oldFile?.name,
        baseline.oldFile ? hashString(baseline.oldFile.contents) : null,
      ])}
      {...props}
      oldFile={baseline.oldFile}
    />
  );
}

function EditableDiffSession({
  value,
  query,
  oldFile,
  active,
  onChange,
  onSave,
  scrollMemoryKey,
}: EditableDiffEditorProps & { oldFile: FileContents | null }) {
  const sessionKey = useId();
  const historyRoot = useRef<HTMLDivElement>(null);
  const codeView = useRef<CodeViewHandle<undefined, undefined>>(null);
  useLayoutEffect(() => {
    if (!active || !historyRoot.current) return;
    return registerEditHistory(historyRoot.current, (direction, target) => {
      if (isNativeEditHistoryTarget(target)) return false;
      codeView.current?.getEditor(query.path)?.[direction]();
      return true;
    });
  }, [active, query.path]);
  // A native edit can be followed by Save before React commits its draft prop.
  const currentValue = useRef(value);
  const theme = useCodeTheme();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useScrollMemory(scroller, scrollMemoryKey);
  const [item, setItem] = useState<CodeViewItem<undefined>>(() => {
    const file = { name: query.path, contents: value };
    // An empty comparison has no diff rows to attach an editor to. Pierre's
    // file editor supplies the initial caret without inventing a saved line.
    return value === "" && !oldFile?.contents
      ? { id: query.path, type: "file", version: 0, file }
      : {
          id: query.path,
          type: "diff",
          version: 0,
          fileDiff: withEditableContext(parseDiffFromFile(oldFile, file)),
        };
  });
  // Edit notifications go to the shared draft, not back into controlled items.
  // Replacing input per keystroke destroys native selection/IME/undo state.
  const items = useMemo(() => [{ ...item, edit: true }], [item]);
  // An empty base is a new or untracked file: no row wash, only bars and +.
  const newFile = oldFile === null;
  const options = useMemo(() => {
    const base = zerosCodeViewOptions({
      diffStyle: "unified",
      codeThemeId: theme,
      disableFileHeader: true,
      surface: "bg1",
    });
    // Removed lines are no longer part of the file: a drag passes over them
    // unpainted and Copy leaves them out.
    return {
      ...base,
      unsafeCSS: `${base.unsafeCSS}
  [data-line][data-line-type="change-deletion"] { -webkit-user-select: none; user-select: none; }${newFile ? NEW_FILE_DIFF_CSS : ""}`,
      // The plain editor's 12px above the first line and below the last.
      layout: {
        ...DEFAULT_CODE_VIEW_LAYOUT,
        ...base.layout,
        paddingTop: 12,
        paddingBottom: 12,
      },
      expandUnchanged: true,
    };
  }, [theme, newFile]);
  useEffect(
    () => () => {
      EditStateManager.clear("file-diff", sessionKey);
      EditStateManager.clear("file", sessionKey);
    },
    [sessionKey],
  );
  return (
    <div
      ref={historyRoot}
      data-editable-diff
      className="h-full min-h-0 select-text"
      aria-label={`Editable diff for ${query.path}`}
      onKeyDownCapture={(event) => {
        if (
          active &&
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          event.stopPropagation();
          onSave(currentValue.current);
        }
      }}
    >
      <EditProvider createEditor={createEditor}>
        {/* A virtual viewport initialized at zero size cannot attach an editor.
            Keep the document/session here; mount its viewport only when shown. */}
        {active && (
          <CodeView
            ref={codeView}
            items={items}
            options={options}
            containerRef={setScroller}
            getEditStateKey={() => sessionKey}
            onItemEditChange={(event) => {
              if (active) {
                currentValue.current = event.file.contents;
                onChange(event.file.contents);
              }
            }}
            onItemEditComplete={(_event, _item, nextItem) => {
              setItem((current) => ({
                ...(nextItem.type === "diff"
                  ? {
                      ...nextItem,
                      fileDiff: withEditableContext(nextItem.fileDiff),
                    }
                  : nextItem),
                version: (current.version ?? 0) + 1,
              }));
              return "accept";
            }}
            className="h-full min-h-0 overflow-x-hidden overflow-y-auto"
          />
        )}
      </EditProvider>
    </div>
  );
}
