// ──────────────────────────────────────────────────────────
// useOpenFileInWorkbench / useOpenChatFileInWorkbench — open a file in the workbench viewer
// ──────────────────────────────────────────────────────────
//
// useOpenFileInWorkbench (All Files / Changes) follows the ACTIVE tab: an active
// File tab is reused in place (even if the file is open in another tab — the
// list drives that one tab like a scratchpad, so reviewing never yanks you
// around), except when replacement would destroy that tab's unsaved draft. In
// that case the target focuses/opens separately while the dirty tab stays
// mounted. When there's no active File tab, an already-open file is focused or
// a fresh tab opens (see planWorkbenchFileOpen). useOpenChatFileInWorkbench
// (agent-chat references) is deliberately separate — it resolves the loose
// reference + focuses-or-opens its own tab, never reusing the active tab. No-op
// for an empty path.
// ──────────────────────────────────────────────────────────

import { useCallback } from "react";

import {
  useActiveWorkbenchTabId,
  useWorkbenchTabs,
  useWorkspaceDispatch,
  useWorkspaceStore,
} from "@/renderer/state/store";
import { workbenchScopeForFolder } from "@/renderer/state/workspace-store";
import {
  createFilesTab,
  defaultScopeFor,
  planWorkbenchFileOpen,
} from "./tab-model";
import { buildDirectFileOpenAction } from "./direct-file-open";
import { useWorkbenchDirtyEditorIds } from "./tabs/code-editor/editor-state";
import { pickFileMatch } from "../resolve-file-ref";
import { loadWorkspaceFileRead } from "../workspace-file-data-cache";
import {
  loadWorkspaceFiles,
  peekWorkspaceFiles,
} from "../workspace-files-cache";

function baseName(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

/** Reduce an absolute path to one relative to `cwd` so the workbench viewer reads
 *  it (and shows a clean breadcrumb) exactly like a file-tree selection.
 *  Returns null when the path isn't inside the workspace — those can't open
 *  here, so the click is a no-op rather than a broken navigation. */
function relativeToCwd(abs: string, cwd: string): string | null {
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (!abs.startsWith(base)) return null;
  const rel = abs.slice(base.length);
  return rel.length > 0 ? rel : null;
}

/** Open a workbench file, optionally in Diff mode. `opts.diff` opens the viewer's
 *  Diff view (the file's changes vs its base); omitting it opens the read-only
 *  source ("Edit") view. The intent is (re)applied on EVERY open — so clicking
 *  the same file from Changes (Diff) and then from All Files (source) switches
 *  the open tab's mode in place rather than going dead on the first one. */
/** Diff intent carried onto the workbench tab: open in Diff mode, which diff to show
 *  (mirrors the Changes filter), the commit SHA for `diffScope:"commit"`, and
 *  whether the Discard control is allowed (All-changes filter + uncommitted). */
export interface OpenFileOpts {
  diff?: boolean;
  diffScope?: "all" | "uncommitted" | "staged" | "unstaged" | "commit" | "turn";
  diffSha?: string;
  /** When `diffScope === "turn"`: the chat + turn whose authored diff to show. */
  turnChatId?: string;
  turnId?: string;
  discardable?: boolean;
  /** True only when Git says the path is untracked or staged-new. */
  isNewFile?: boolean;
}

export function useOpenFileInWorkbench(): (
  path: string,
  opts?: OpenFileOpts,
) => void {
  const tabs = useWorkbenchTabs();
  const activeId = useActiveWorkbenchTabId();
  const dirtyEditorIds = useWorkbenchDirtyEditorIds();
  const dispatch = useWorkspaceDispatch();
  // Read `tabs` + `activeId` live (in deps) so the open always resolves against
  // the latest active-worktree slice — both persist across renders and worktree
  // switches.
  return useCallback(
    (rawPath: string, opts?: OpenFileOpts) => {
      const path = rawPath.trim();
      if (!path) return;
      // Intent — written on every open (including the cleared cases) so the
      // viewer tracks the most recent entry point: re-opening the same file from
      // a different filter switches its diff + discard affordance in place.
      const intent = {
        diff: opts?.diff ?? false,
        diffScope: opts?.diffScope,
        diffSha: opts?.diffSha,
        turnChatId: opts?.turnChatId,
        turnId: opts?.turnId,
        discardable: opts?.discardable ?? false,
        isNewFile: opts?.isNewFile ?? false,
        // A file-open is a new navigation intent. The viewer follows its entry
        // point default until the user explicitly chooses another mode again.
        viewerMode: undefined,
      };
      // A tracked discard uses a non-zero revision to clear editor state and
      // land in Edit (including Markdown). A fresh user open is a new intent,
      // so clear that one-shot marker and resume the entry point's default —
      // EXCEPT when the reused tab's editor holds an unsaved draft: the
      // SourceEditor is keyed on the revision, so resetting it would remount
      // the editor and silently destroy the draft. (planWorkbenchFileOpen only reuses a
      // dirty tab when it already shows `path`, so preserving is safe.)
      const updatesFor = (tabId: string) =>
        dirtyEditorIds.has(tabId) ? intent : { ...intent, contentRevision: 0 };
      // Follow the ACTIVE tab (planWorkbenchFileOpen): reuse the active File tab in place
      // unless it owns another path's unsaved draft; otherwise preserve that
      // tab and focus/open the target separately.
      const plan = planWorkbenchFileOpen(
        tabs,
        activeId,
        path,
        activeId ? dirtyEditorIds.has(activeId) : false,
      );
      switch (plan.kind) {
        case "focus":
          // No active File tab to reuse, but the file is already open → focus it
          // AND re-point its intent.
          dispatch({
            type: "OPEN_WORKBENCH_TAB",
            id: plan.id,
            updates: updatesFor(plan.id),
          });
          return;
        case "replace": {
          // The active tab is a File tab → swap its file (+ intent) in place
          // (even if this file is open elsewhere), so the click lands where the
          // user already is; then ensure it's frontmost. Tree visibility is
          // owned by the destination tab and survives this reuse; only the
          // genuinely-new branch below starts with the collapsed default.
          dispatch({
            type: "OPEN_WORKBENCH_TAB",
            id: plan.id,
            updates: {
              filePath: path,
              title: baseName(path),
              ...updatesFor(plan.id),
            },
          });
          return;
        }
        case "new":
          // Active tab is the Browser and no File tab is empty or matching → a
          // fresh File tab (appended + activated by the reducer).
          dispatch({
            type: "ADD_WORKBENCH_TAB",
            tab: createFilesTab(path, intent),
          });
          return;
      }
    },
    [tabs, activeId, dirtyEditorIds, dispatch],
  );
}

/** Open a file referenced in agent-chat output in workbench — focusing it if it's
 *  already open in any File tab, otherwise adding a new tab. The reference is
 *  resolved first: a full path reads directly, a bare basename / sub-path is
 *  matched against the workspace file list, and an absolute path is relativised
 *  against `cwd`. Anything that doesn't resolve stays inert (no "file no longer
 *  exists" tab). Fire-and-forget; resolution is async. */
export function useOpenChatFileInWorkbench(): (
  cwd: string | undefined,
  rawPath: string,
) => void {
  // Focus an already-open File tab, fill the FIXED Files home when it is blank,
  // else add a new tab. The shared policy preserves an existing destination's
  // tree choice; only a newly allocated File tab starts collapsed. Read the
  // exact scope at completion time because an uncached agent reference can
  // resolve after the user has switched tabs or workspaces.
  const openTab = useCallback((cwd: string, target: string) => {
    const scope = workbenchScopeForFolder(cwd);
    const state = useWorkspaceStore.getState();
    const scopeState = state.workbenchByScope[scope] ?? defaultScopeFor(scope);
    state.dispatch(
      buildDirectFileOpenAction(scopeState.tabs, target, {
        preferredExistingTabId: scopeState.activeId,
        scope,
      }),
    );
  }, []);
  return useCallback(
    (cwd, rawPath) => {
      let path = rawPath.trim();
      if (!path || !cwd) return;
      // An absolute path the agent referenced (e.g. a `[name](/Users/…/x.ts)`
      // link) is relativised against the workspace; if it falls outside, open
      // nothing — never navigate the app to a localhost/<abs-path> URL.
      if (path.startsWith("/")) {
        const rel = relativeToCwd(path, cwd);
        if (rel == null) return;
        path = rel;
      }
      // Fast path: resolve against the warm file-list cache and open the tab
      // SYNCHRONOUSLY — the click feels instant, no IPC before the tab appears.
      // A full path matches by exact membership; a bare basename / sub-path
      // (the agent often writes just "AskAIChat.tsx") via pickFileMatch.
      const cached = peekWorkspaceFiles(cwd);
      if (cached) {
        const target = cached.includes(path)
          ? path
          : pickFileMatch(cached, path);
        if (target) {
          openTab(cwd, target);
        } else {
          // Not in the (possibly stale) list — maybe just-created or gitignored.
          // One read verifies it before opening; a dead ref opens nothing.
          void verifyThenOpen(cwd, path, (target) =>
            openTab(cwd, target),
          ).catch(() => {});
        }
        return;
      }
      // Cold cache (a click before the background warm-up finished): resolve
      // async this once; every later click in this workspace is then instant.
      void (async () => {
        try {
          const files = await loadWorkspaceFiles(cwd);
          const target = files.includes(path)
            ? path
            : pickFileMatch(files, path);
          if (target) openTab(cwd, target);
          else
            await verifyThenOpen(cwd, path, (target) => openTab(cwd, target));
        } catch {
          // A direct read can still validate a gitignored/new path. If the
          // engine is unavailable too, leave the existing route untouched.
          await verifyThenOpen(cwd, path, (target) =>
            openTab(cwd, target),
          ).catch(() => {});
        }
      })();
    },
    [openTab],
  );
}

/** Open `path` only if it actually reads — the fallback for a reference that
 *  isn't in the cached file list (a just-created or gitignored file). Keeps the
 *  "no dead-reference tab" guarantee without a read on the common (cached) path. */
async function verifyThenOpen(
  cwd: string,
  path: string,
  openTab: (target: string) => void,
): Promise<void> {
  // Verify through the same exact-key cache the destination viewer consumes.
  // The successful read is therefore already available in its first render,
  // and an external invalidation can supersede this request without a stale
  // response being published afterward.
  const res = await loadWorkspaceFileRead(
    { cwd, path, contentRevision: 0 },
    { force: true },
  );
  if (res && res.kind !== "error") openTab(path);
}
