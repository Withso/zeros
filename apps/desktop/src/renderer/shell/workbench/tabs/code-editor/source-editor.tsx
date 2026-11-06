// ──────────────────────────────────────────────────────────
// SourceEditor — editable file source for the Files-tab Edit mode
// ──────────────────────────────────────────────────────────
//
// Shares one draft between source and Pierre diff editing, with auto save and
// dirty tracking plus ⌘S / File options save through
// the engine write path (writeWorkspaceFile). A Git conflict is resolved in
// place (merge-conflict-blocks): accepting a block is an ordinary edit, so it
// shares this draft, its undo history and its saves. The on-disk file is authoritative:
// agent, terminal, Git, and other external writes are adopted immediately with
// no conflict banner, whether this File tab is active or mounted in the
// background. The one protected race is our own save echo, which must not erase
// keystrokes entered while that save was in flight.
//
// Mounted with key={cwd::path} by the file viewer, so a new file = fresh state.
// The viewer owns the on-disk read (it re-reads on gitRefresh) and passes the
// latest `content` down; this component owns the editable draft.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { CodeEditor } from "./index";
import { isCloudWorkspace } from "@/renderer/platform/bridge/cloud-workspace-key";
import {
  writeWorkspaceFile,
  type WriteFileResult,
} from "@/renderer/platform/files";
import { triggerGitRefresh } from "@/renderer/shell/use-git-refresh-key";
import { setWorkbenchEditorDirty, takeWorkbenchEditorClosing } from "./editor-state";
import { resolveDiskContentSync } from "./source-editor-sync";
import { consumeForgottenEditorDraft, editorDraftJournal, editorDraftKey } from "./draft-journal";
import { onNativeBeforeQuit } from "@/renderer/platform/runtime";
import { recordWorkspaceActivity } from "@/renderer/state/workspace-store";
import type { CodeReviewController } from "@/renderer/features/code-review/use-code-review";
import { useEditorCodeReview } from "@/renderer/features/code-review/use-editor-code-review";
import { conflictMarkerNotice } from "@/renderer/features/code-review/merge-conflict-rows";
import { MessageRow } from "@/renderer/shared/ui/primitives/message-row";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import type { EditorView } from "@codemirror/view";
import type { WorkspaceFileDiffQuery } from "../../../workspace-file-data-cache";
import { EditableDiffEditor } from "./editable-diff-editor";
import type { FileEditorControls } from "./file-editor-options";
import { goToConflict, mergeConflictBlocks, type EditorConflictStatus } from "./merge-conflict-blocks";

/** A rejected write never reached a verdict (engine or cloud VM unreachable,
 * stopped, reconnecting); it is retried. A write the engine refused is final. */
const SAVE_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const saveRetryDelay = (attempt: number) =>
  SAVE_RETRY_DELAYS_MS[Math.min(attempt, SAVE_RETRY_DELAYS_MS.length) - 1]!;
const DRAFT_JOURNAL_DELAY_MS = 150;
const fileName = (path: string) => path.split("/").pop() || path;

interface SourceEditorProps {
  /** Owning File-tab id. Dirty state is registered per tab so this editor can
   * remain mounted while the user works in Terminal/Browser. */
  editorId: string;
  cwd: string;
  path: string;
  /** The latest on-disk content (the viewer re-reads this on gitRefresh). */
  content: string;
  /** True while the viewer shows Diff / Markdown preview instead of this editor
   *  — it stays mounted only to keep its draft, so it skips the synchronous
   *  first-paint highlight it wouldn't be painting anyway. */
  offscreen?: boolean;
  /** The owning File tab may still save its draft while showing Preview. */
  active?: boolean;
  autoSave?: boolean;
  editableDiffQuery?: WorkspaceFileDiffQuery;
  refreshKey?: number;
  isNewFile?: boolean;
  onControlsChange?: (controls: FileEditorControls | null) => void;
  review: CodeReviewController;
  /** Git lists the file as unmerged: mark its conflict blocks in place. */
  isGitConflict?: boolean;
}

export function SourceEditor({
  editorId,
  cwd,
  path,
  content,
  offscreen,
  active = !offscreen,
  autoSave = false,
  editableDiffQuery,
  refreshKey = 0,
  isNewFile = false,
  onControlsChange,
  review,
  isGitConflict = false,
}: SourceEditorProps) {
  const [draft, setDraft] = useState(content);
  const baselineRef = useRef(content); // last on-disk content we're in sync with
  const lastContentRef = useRef(content); // last `content` prop we processed
  const pendingSaveRef = useRef<string | null>(null);
  const saveEchoesRef = useRef<string[]>([]);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  useLayoutEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [editRevision, setEditRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== baselineRef.current;
  const currentDraft = useRef(draft);
  const viewRef = useRef<EditorView | null>(null);
  const [conflictStatus, setConflictStatus] = useState<EditorConflictStatus | null>(null);
  const conflicts = isGitConflict ? conflictStatus : null;
  // Diff view waits until Git no longer lists the file as conflicted, so an
  // accept never swaps editors and drops the undo history behind it.
  const diffQuery = isGitConflict ? undefined : editableDiffQuery;
  const [retryAttempt, setRetryAttempt] = useState(0);
  // The baseline is a ref; a confirmed save bumps this so effects that depend
  // on "is the draft saved" re-run even when React batches saving true/false.
  const [savedRevision, setSavedRevision] = useState(0);
  const explicitRetry = useRef<{ attempt: number; timer: ReturnType<typeof setTimeout> | null; generation: number }>({ attempt: 0, timer: null, generation: 0 });
  // A retry must never write text the user discarded or an adopted disk
  // update replaced, including a save still in flight when that happened.
  const cancelExplicitRetry = useCallback(() => {
    const retry = explicitRetry.current;
    if (retry.timer) clearTimeout(retry.timer);
    retry.timer = null;
    retry.attempt = 0;
    retry.generation += 1;
  }, []);
  const autoSaveRef = useRef(autoSave);
  autoSaveRef.current = autoSave;
  const editedSinceOpen = useRef(false);
  const journalKey = useMemo(() => editorDraftKey(cwd, path), [cwd, path]);
  const flushJournal = useRef<(() => Promise<void>) | null>(null);
  const journalWrite = useRef<Promise<void>>(Promise.resolve());
  // Only an entry this editor wrote is removed when its draft becomes clean;
  // a clean first render must not race the restore read for an older entry.
  const journaled = useRef(false);
  const editorReview = useEditorCodeReview({
    review,
    path,
    content: draft,
    active: !offscreen && !diffQuery,
  });
  const conflictBlocks = useMemo(
    () => (isGitConflict ? mergeConflictBlocks(setConflictStatus) : null),
    [isGitConflict],
  );
  const editorExtensions = useMemo(
    () => (conflictBlocks ? [editorReview.extensions, conflictBlocks] : editorReview.extensions),
    [editorReview.extensions, conflictBlocks],
  );
  const reviewCreateView = editorReview.onCreateView;
  const createView = useCallback((view: EditorView) => {
    viewRef.current = view;
    reviewCreateView?.(view);
  }, [reviewCreateView]);

  // Register the dirty transition in the same input event as the draft write.
  // React normally flushes the effect below before the next tab click, but this
  // closes the tiny type→immediate-Terminal-click window deterministically.
  const changeDraft = useCallback(
    (next: string) => {
      editedSinceOpen.current = true;
      currentDraft.current = next;
      setDraft(next);
      setError(null);
      setRetryAttempt(0);
      setWorkbenchEditorDirty(editorId, next !== baselineRef.current);
    },
    [editorId],
  );

  const restoreDraft = useCallback(
    (text: string) => {
      if (!mountedRef.current) return;
      currentDraft.current = text;
      setDraft(text);
      setError(null);
      setRetryAttempt(0);
      setEditRevision(version => version + 1);
      setWorkbenchEditorDirty(editorId, text !== baselineRef.current);
    },
    [editorId],
  );

  // Reopening a file brings back what was typed but never saved. It is applied
  // only onto the exact content it was edited from; a file changed since then
  // keeps its disk content and the draft is offered instead.
  useEffect(() => {
    if (!journalKey) return;
    let cancelled = false;
    const journal = editorDraftJournal();
    if (consumeForgottenEditorDraft(journalKey)) {
      void journal.remove(journalKey).catch(() => {});
      return;
    }
    void journal.read(journalKey).then(entry => {
      if (cancelled || !entry) return;
      if (entry.draft === baselineRef.current) {
        if (!journaled.current) void journal.remove(journalKey).catch(() => {});
      } else if (!editedSinceOpen.current && entry.base === baselineRef.current) {
        restoreDraft(entry.draft);
      } else {
        toast.info(`Unsaved changes to ${fileName(path)} weren't restored because the file changed.`, {
          id: `editor-draft:${journalKey}`,
          duration: 20_000,
          action: { label: "Restore", onClick: () => restoreDraft(entry.draft) },
        });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [journalKey, path, restoreDraft]);

  // Keep the unsaved draft outside this renderer as it changes, so a closed
  // tab, closed window, quit, update or archive cannot discard it.
  useEffect(() => {
    if (!journalKey) return;
    const flush = () => {
      flushJournal.current = null;
      const journal = editorDraftJournal();
      const text = currentDraft.current;
      const base = baselineRef.current;
      if (text === base && !journaled.current) return journalWrite.current;
      journaled.current = text !== base;
      journalWrite.current = (text === base
        ? journal.remove(journalKey)
        : journal.write({ key: journalKey, base, draft: text, updatedAt: Date.now() })
      ).catch(() => {});
      return journalWrite.current;
    };
    flushJournal.current = flush;
    const timer = setTimeout(flush, DRAFT_JOURNAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [journalKey, draft, dirty, savedRevision]);

  // Quit and Restart to Update wait for this write; closing the window or
  // hiding the app flushes as well, best effort.
  useEffect(() => {
    const flush = () => { void flushJournal.current?.(); };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    const stopQuit = onNativeBeforeQuit(async () => {
      await flushJournal.current?.();
      await journalWrite.current;
    });
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      stopQuit();
    };
  }, []);

  useEffect(() => () => {
    void flushJournal.current?.();
    const retry = explicitRetry.current;
    if (retry.timer) clearTimeout(retry.timer);
    if (takeWorkbenchEditorClosing(editorId) && journalKey && !savingRef.current &&
        currentDraft.current !== baselineRef.current)
      toast.info(`Unsaved changes to ${fileName(path)} are kept`, {
        description: "Open the file again to continue editing.",
      });
  }, [editorId, journalKey, path]);

  // Mirror the dirty state to the per-tab registry (see editor-state) so
  // this File surface stays mounted across Terminal/Browser switches. Cleared
  // on unmount; the draft journal keeps a closed editor's unsaved text.
  useEffect(() => {
    setWorkbenchEditorDirty(editorId, dirty);
    return () => setWorkbenchEditorDirty(editorId, false);
  }, [editorId, dirty]);

  // A genuinely new disk read always wins. An echo of this editor's own pending
  // save advances the baseline without resetting `draft`, preserving text typed
  // while the write was in flight.
  useEffect(() => {
    const sync = resolveDiskContentSync({
      incoming: content,
      lastSeen: lastContentRef.current,
      baseline: baselineRef.current,
      draft,
      pendingSave: pendingSaveRef.current,
      saveEchoes: saveEchoesRef.current,
    });
    if (sync.kind === "unchanged") return;
    lastContentRef.current = content;
    baselineRef.current = sync.baseline;
    pendingSaveRef.current = sync.pendingSave;
    if (sync.kind === "adopt-disk") {
      cancelExplicitRetry();
      saveEchoesRef.current = [];
      currentDraft.current = sync.draft;
      setDraft(sync.draft);
      setEditRevision(version => version + 1);
      setError(null);
      // Clear synchronously so a dirty inactive File can return to lazy mounting
      // as soon as the authoritative external update has been adopted.
      setWorkbenchEditorDirty(editorId, false);
    }
  }, [content, draft, editorId, cancelExplicitRetry]);

  const save = useCallback(
    async (text: string) => {
      if (savingRef.current || !activeRef.current) return;
      if (text === baselineRef.current) return;
      const lastSeenAtSaveStart = lastContentRef.current;
      pendingSaveRef.current = text;
      savingRef.current = true;
      setSaving(true);
      setError(null);
      // A save attempt is a deliberate workspace action at invocation time,
      // just like a submitted terminal command or prompt. Record before the
      // transport await so a slow write cannot leapfrog a later action in a
      // different workspace; ordinary typing remains passive.
      recordWorkspaceActivity(cwd);
      const retry = explicitRetry.current;
      const generation = retry.generation;
      if (retry.timer) { clearTimeout(retry.timer); retry.timer = null; }
      // writeWorkspaceFile rejects on transport absence (engine bridge down,
      // still connecting, cloud VM stopped or waking) instead of resolving.
      let unreachable = false;
      const res = await writeWorkspaceFile(cwd, path, text).catch(
        (err: unknown): WriteFileResult => {
          unreachable = true;
          return { kind: "error", path, bytes: 0, error: err instanceof Error ? err.message : String(err) };
        },
      );
      savingRef.current = false;
      if (unreachable) {
        // The draft is journaled, so this waits quietly: autosave retries the
        // latest text with backoff (and at once after the next edit); an
        // explicit save with autosave off retries the text it asked for.
        if (pendingSaveRef.current === text) pendingSaveRef.current = null;
        if (mountedRef.current) {
          if (autoSaveRef.current) setRetryAttempt(attempt => attempt + 1);
          else if (generation === retry.generation) {
            retry.attempt += 1;
            retry.timer = setTimeout(() => {
              retry.timer = null;
              void saveRef.current(text);
            }, saveRetryDelay(retry.attempt));
          }
        }
      } else if (res && res.kind === "success") {
        retry.attempt = 0;
        if (mountedRef.current) { setRetryAttempt(0); setSavedRevision(revision => revision + 1); }
        // Advance the baseline only — do NOT reset `draft`. The editor stays
        // editable during the await, so resetting it would silently discard any
        // keystrokes typed mid-save (and clear `dirty`, hiding the loss). A clean
        // draft already equals `text`; an edited one stays dirty so the next
        // save persists it.
        // If a different external version arrived while this write was pending,
        // leave its adopted baseline intact until the refresh below confirms
        // which writer won. Otherwise this successful write is authoritative.
        if (
          lastContentRef.current === lastSeenAtSaveStart ||
          lastContentRef.current === text
        ) {
          baselineRef.current = text;
        }
        saveEchoesRef.current = [...saveEchoesRef.current.filter(value => value !== text), text].slice(-4);
        if (mountedRef.current) setWorkbenchEditorDirty(editorId, currentDraft.current !== baselineRef.current);
        triggerGitRefresh(cwd); // origin-side File / All Files / Changes refresh
      } else {
        if (pendingSaveRef.current === text) pendingSaveRef.current = null;
        setError(res?.error ?? "Couldn't save the file");
        toast.error("Couldn't save file", { description: res?.error ?? "Try saving again when the workspace is available." });
      }
      setSaving(false);
    },
    [cwd, path, editorId],
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  // One debounce per visible owning tab. A refused write keeps the draft and
  // stops automatic retries until another edit or an explicit Save file; an
  // unreachable one retries with backoff. Conflicted files save like any other.
  useEffect(() => {
    if (!autoSave || !active || !dirty || saving || error) return;
    const delay = retryAttempt ? saveRetryDelay(retryAttempt) : 500;
    const timer = setTimeout(() => { void save(currentDraft.current); }, delay);
    return () => clearTimeout(timer);
  }, [autoSave, active, dirty, draft, saving, error, save, retryAttempt]);

  const discardDraft = useCallback(() => {
    if (!activeRef.current || savingRef.current) return;
    cancelExplicitRetry();
    currentDraft.current = baselineRef.current;
    setDraft(baselineRef.current);
    setError(null);
    setEditRevision(version => version + 1);
    setWorkbenchEditorDirty(editorId, false);
  }, [editorId, cancelExplicitRetry]);
  const conflictCount = conflicts?.count ?? 0;
  const conflictShown = conflicts?.shown ?? 0;
  const controls = useMemo<FileEditorControls>(() => ({
    dirty, saving,
    canSave: active && dirty && !saving,
    canDiscard: active && dirty && !saving,
    save: () => { void save(currentDraft.current); }, discard: discardDraft,
    conflicts: conflictCount
      ? {
          count: conflictCount,
          shown: conflictShown,
          previous: () => { if (viewRef.current) goToConflict(viewRef.current, -1); },
          next: () => { if (viewRef.current) goToConflict(viewRef.current, 1); },
        }
      : null,
  }), [active, dirty, saving, save, discardDraft, conflictCount, conflictShown]);
  useLayoutEffect(() => { onControlsChange?.(controls); }, [onControlsChange, controls]);
  useLayoutEffect(() => () => { onControlsChange?.(null); }, [onControlsChange]);

  const markerNotice = conflictMarkerNotice(conflicts?.parsed);

  return (
    <div
      className="bg-bg1 relative flex h-full min-h-0 flex-col"
      onBlur={event => {
        if (autoSave && !error && !event.currentTarget.contains(event.relatedTarget)) void save(currentDraft.current);
      }}
      {...(offscreen ? { inert: "" } : {})}
    >
      {markerNotice && (
        <MessageRow tone="error" bar role="status">
          {markerNotice}
        </MessageRow>
      )}
      {error && (
        <MessageRow tone="error" bar role="alert">
          {`Couldn't save ${path}. Your edits are kept; ⌘S tries again.`}
        </MessageRow>
      )}
      <div className="min-h-0 flex-1">
        {diffQuery ? (
          <EditableDiffEditor query={diffQuery} value={draft} savedContent={content}
            revision={editRevision} refreshKey={refreshKey} isNewFile={isNewFile}
            active={!offscreen} onChange={changeDraft} onSave={save}
            scrollMemoryKey={JSON.stringify(["editable-diff", cwd, editorId, path])} />
        ) : <>
        <CodeEditor
          tokenCacheScope={cwd && !isCloudWorkspace(cwd) ? "local" : undefined}
          value={draft}
          historyRevision={editRevision}
          filePath={path}
          onChange={changeDraft}
          onSave={save}
          offscreen={offscreen}
          additionalExtensions={editorExtensions}
          onCreateView={createView}
          ariaLabel={`Source editor for ${path}. Press Command or Control Shift M to comment.`}
          scrollMemoryKey={JSON.stringify(["editor", cwd, editorId, path])}
        />
        {editorReview.portals}
        </>}
      </div>
    </div>
  );
}
