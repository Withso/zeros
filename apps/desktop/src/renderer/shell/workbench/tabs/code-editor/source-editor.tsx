// ──────────────────────────────────────────────────────────
// SourceEditor — editable file source for the Files-tab Edit mode
// ──────────────────────────────────────────────────────────
//
// Wraps <CodeEditor> with file I/O: dirty tracking and ⌘S / button save through
// the engine write path (writeWorkspaceFile). The on-disk file is authoritative:
// agent, terminal, Git, and other external writes are adopted immediately with
// no conflict banner, whether this File tab is active or mounted in the
// background. The one protected race is our own save echo, which must not erase
// keystrokes entered while that save was in flight.
//
// Mounted with key={cwd::path} by the file viewer, so a new file = fresh state.
// The viewer owns the on-disk read (it re-reads on gitRefresh) and passes the
// latest `content` down; this component owns the editable draft.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { Save } from "lucide-react";

import { CodeEditor } from "./index";
import {
  writeWorkspaceFile,
  type WriteFileResult,
} from "@/renderer/platform/files";
import { triggerGitRefresh } from "@/renderer/shell/use-git-refresh-key";
import { setWorkbenchEditorDirty } from "./editor-state";
import { resolveDiskContentSync } from "./source-editor-sync";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { recordWorkspaceActivity } from "@/renderer/state/workspace-store";
import type { CodeReviewController } from "@/renderer/features/code-review/use-code-review";
import { useEditorCodeReview } from "@/renderer/features/code-review/use-editor-code-review";
import { MergeConflictActions } from "@/renderer/features/code-review/merge-conflict-actions";
import type { GitReviewActionsClient } from "@/renderer/platform/git-review-actions";
import { Button } from "@/renderer/shared/ui/primitives";

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
  review: CodeReviewController;
  isGitConflict?: boolean;
  reviewActionClient?: GitReviewActionsClient;
}

export function SourceEditor({
  editorId,
  cwd,
  path,
  content,
  offscreen,
  review,
  isGitConflict = false,
  reviewActionClient,
}: SourceEditorProps) {
  const [draft, setDraft] = useState(content);
  const baselineRef = useRef(content); // last on-disk content we're in sync with
  const lastContentRef = useRef(content); // last `content` prop we processed
  const pendingSaveRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolutionPreview, setResolutionPreview] = useState<string | null>(
    null,
  );
  const [conflictReset, setConflictReset] = useState(0);
  const [conflictSaving, setConflictSaving] = useState(false);
  const conflictSavingRef = useRef(false);
  const conflictSubmitted = useRef<string | null>(null);
  const conflictStartDraft = useRef(content);
  const conflictStartDisk = useRef(content);
  const conflictSucceeded = useRef(false);
  const currentPreview = useRef(resolutionPreview);
  currentPreview.current = resolutionPreview;
  const displayed = resolutionPreview ?? draft;
  const dirty = displayed !== baselineRef.current;
  const separateDraftDirty =
    resolutionPreview === null && draft !== baselineRef.current;
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const editorReview = useEditorCodeReview({
    review,
    path,
    content: displayed,
    active: !offscreen,
  });

  // Register the dirty transition in the same input event as the draft write.
  // React normally flushes the effect below before the next tab click, but this
  // closes the tiny type→immediate-Terminal-click window deterministically.
  const changeDraft = useCallback(
    (next: string) => {
      if (conflictSavingRef.current || currentPreview.current !== null) return;
      currentDraft.current = next;
      setDraft(next);
      setWorkbenchEditorDirty(editorId, next !== baselineRef.current);
    },
    [editorId],
  );

  // Mirror the dirty state to the per-tab registry (see editor-state) so
  // this File surface stays mounted across Terminal/Browser switches. Cleared
  // on unmount — an explicitly closed editor holds nothing to preserve.
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
    });
    if (sync.kind === "unchanged") return;
    lastContentRef.current = content;
    baselineRef.current = sync.baseline;
    pendingSaveRef.current = sync.pendingSave;
    if (sync.kind === "adopt-disk") {
      currentDraft.current = sync.draft;
      setDraft(sync.draft);
      setError(null);
      // Clear synchronously so a dirty inactive File can return to lazy mounting
      // as soon as the authoritative external update has been adopted.
      setWorkbenchEditorDirty(editorId, false);
    }
  }, [content, draft, editorId]);

  const save = useCallback(
    async (text: string) => {
      if (
        saving ||
        offscreen ||
        resolutionPreview !== null ||
        conflictSavingRef.current
      )
        return;
      const lastSeenAtSaveStart = lastContentRef.current;
      pendingSaveRef.current = text;
      setSaving(true);
      setError(null);
      // A save attempt is a deliberate workspace action at invocation time,
      // just like a submitted terminal command or prompt. Record before the
      // transport await so a slow write cannot leapfrog a later action in a
      // different workspace; ordinary typing remains passive.
      recordWorkspaceActivity(cwd);
      // writeWorkspaceFile rejects on transport absence (engine bridge down /
      // still connecting) instead of resolving null. Fold that into the same
      // failure branch as an engine-reported error, so `saving` always resets
      // and the save error surfaces instead of wedging the button.
      const res = await writeWorkspaceFile(cwd, path, text).catch(
        (err: unknown): WriteFileResult => ({
          kind: "error",
          path,
          bytes: 0,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      setSaving(false);
      if (res && res.kind === "success") {
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
        triggerGitRefresh(cwd); // origin-side File / All Files / Changes refresh
      } else {
        if (pendingSaveRef.current === text) pendingSaveRef.current = null;
        setError(res?.error ?? "Couldn't save the file");
      }
    },
    [cwd, path, saving, offscreen, resolutionPreview],
  );

  const previewResolution = useCallback(
    (text: string) => {
      // The conflict component builds from disk. A separate manual edit must be
      // saved or undone before a disk-based preview may take over the editor.
      if (
        conflictSavingRef.current ||
        currentDraft.current !== baselineRef.current
      )
        return;
      if (text === content) {
        setResolutionPreview(null);
        currentPreview.current = null;
        setDraft(content);
        currentDraft.current = content;
        baselineRef.current = content;
        lastContentRef.current = content;
        pendingSaveRef.current = null;
        setWorkbenchEditorDirty(editorId, false);
      } else {
        setResolutionPreview(text);
        currentPreview.current = text;
        setWorkbenchEditorDirty(editorId, true);
      }
    },
    [content, editorId],
  );
  const resolutionSavingChanged = useCallback((pending: boolean) => {
    conflictSavingRef.current = pending;
    setConflictSaving(pending);
    if (pending) {
      conflictSubmitted.current = currentPreview.current;
      conflictStartDraft.current = currentDraft.current;
      conflictStartDisk.current = lastContentRef.current;
      conflictSucceeded.current = false;
      // A DB_CHANGED disk read may arrive before the response. Attribute that
      // echo to this request so it cannot be mistaken for an external write.
      pendingSaveRef.current = conflictSubmitted.current;
    } else {
      if (
        !conflictSucceeded.current &&
        pendingSaveRef.current === conflictSubmitted.current
      )
        pendingSaveRef.current = null;
      conflictSubmitted.current = null;
    }
  }, []);
  const savedResolution = useCallback(
    (text: string) => {
      conflictSucceeded.current = true;
      if (
        lastContentRef.current === conflictStartDisk.current ||
        lastContentRef.current === text
      ) {
        pendingSaveRef.current = text;
        baselineRef.current = text;
        if (
          currentDraft.current === conflictStartDraft.current ||
          currentDraft.current === text
        ) {
          currentDraft.current = text;
          setDraft(text);
        }
      } else if (pendingSaveRef.current === text) pendingSaveRef.current = null;
      currentPreview.current = null;
      setResolutionPreview(null);
      setError(null);
      setWorkbenchEditorDirty(
        editorId,
        currentDraft.current !== baselineRef.current,
      );
      triggerGitRefresh(cwd);
    },
    [cwd, editorId],
  );

  return (
    <div
      className="bg-bg1 relative flex h-full min-h-0 flex-col"
      {...(offscreen ? { inert: "" } : {})}
    >
      <MergeConflictActions
        key={conflictReset}
        cwd={cwd}
        path={path}
        content={content}
        isGitConflict={isGitConflict}
        active={!offscreen && !separateDraftDirty}
        readOnly={saving || separateDraftDirty}
        onPreview={previewResolution}
        onSaved={savedResolution}
        onSavingChange={resolutionSavingChanged}
        client={reviewActionClient}
      />
      {isGitConflict && separateDraftDirty && (
        <p
          role="status"
          className="text-fg2 border-border1 shrink-0 border-b px-2 py-1 text-xs"
        >
          Save or undo your source edits before choosing a conflict resolution.
          Your draft is kept.
        </p>
      )}
      {resolutionPreview !== null && (
        <div className="text-fg3 border-border1 flex shrink-0 items-center gap-2 border-b px-2 py-1 text-xs">
          <span>
            Resolution preview · use Save resolution to write this file.
          </span>
          <Button
            variant="ghost"
            className="ml-auto"
            disabled={!!offscreen || conflictSaving}
            onClick={() => {
              if (conflictSavingRef.current) return;
              currentPreview.current = null;
              setResolutionPreview(null);
              setConflictReset((version) => version + 1);
              setWorkbenchEditorDirty(editorId, draft !== baselineRef.current);
            }}
          >
            Discard resolution preview
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CodeEditor
          value={displayed}
          filePath={path}
          onChange={changeDraft}
          onSave={save}
          offscreen={offscreen}
          readOnly={resolutionPreview !== null || conflictSaving}
          additionalExtensions={editorReview.extensions}
          onCreateView={editorReview.onCreateView}
          ariaLabel={`Source editor for ${path}. Press Command or Control Shift M to comment.`}
          scrollMemoryKey={JSON.stringify(["editor", cwd, editorId, path])}
        />
        {editorReview.portals}
      </div>
      {dirty && resolutionPreview === null && (
        <div className="absolute right-4 bottom-3 z-10 flex items-center gap-2">
          {error && (
            <span className="bg-bg2 text-yellow-primary rounded-sm px-2 py-1 text-xs shadow-sm">
              {error}
            </span>
          )}
          <button
            type="button"
            onClick={() => save(draft)}
            disabled={saving || conflictSaving || !!offscreen}
            className="bg-primary-button-bg text-primary-button-fg flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {saving ? (
              <ZerosSpinner size={14} tone="inverted" />
            ) : (
              <Save className="size-3.5" />
            )}
            {saving ? "Saving…" : "Save"}
            <span className="opacity-60">⌘S</span>
          </button>
        </div>
      )}
    </div>
  );
}
