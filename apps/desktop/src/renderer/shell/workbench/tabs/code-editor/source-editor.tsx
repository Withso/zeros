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
import { writeWorkspaceFile, type WriteFileResult } from "@/renderer/platform/files";
import { triggerGitRefresh } from "@/renderer/shell/use-git-refresh-key";
import { setWorkbenchEditorDirty } from "./editor-state";
import { resolveDiskContentSync } from "./source-editor-sync";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { recordWorkspaceActivity } from "@/renderer/state/workspace-store";

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
}

export function SourceEditor({
  editorId,
  cwd,
  path,
  content,
  offscreen,
}: SourceEditorProps) {
  const [draft, setDraft] = useState(content);
  const baselineRef = useRef(content); // last on-disk content we're in sync with
  const lastContentRef = useRef(content); // last `content` prop we processed
  const pendingSaveRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== baselineRef.current;

  // Register the dirty transition in the same input event as the draft write.
  // React normally flushes the effect below before the next tab click, but this
  // closes the tiny type→immediate-Terminal-click window deterministically.
  const changeDraft = useCallback(
    (next: string) => {
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
      setDraft(sync.draft);
      setError(null);
      // Clear synchronously so a dirty inactive File can return to lazy mounting
      // as soon as the authoritative external update has been adopted.
      setWorkbenchEditorDirty(editorId, false);
    }
  }, [content, draft, editorId]);

  const save = useCallback(
    async (text: string) => {
      if (saving) return;
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
    [cwd, path, saving],
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-bg1">
      <div className="min-h-0 flex-1">
        <CodeEditor
          value={draft}
          filePath={path}
          onChange={changeDraft}
          onSave={save}
          offscreen={offscreen}
          scrollMemoryKey={JSON.stringify(["editor", cwd, editorId, path])}
        />
      </div>
      {dirty && (
        <div className="absolute right-4 bottom-3 z-10 flex items-center gap-2">
          {error && (
            <span className="bg-bg2 text-yellow-primary rounded-sm px-2 py-1 text-xs shadow-sm">
              {error}
            </span>
          )}
          <button
            type="button"
            onClick={() => save(draft)}
            disabled={saving}
            className="bg-primary-button-bg text-primary-button-fg flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {saving ? <ZerosSpinner size={14} tone="inverted" /> : <Save className="size-3.5" />}
            {saving ? "Saving…" : "Save"}
            <span className="opacity-60">⌘S</span>
          </button>
        </div>
      )}
    </div>
  );
}
