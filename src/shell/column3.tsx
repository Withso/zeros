// ──────────────────────────────────────────────────────────
// Column 3 — two stacked tab rows
// ──────────────────────────────────────────────────────────
//
// Column 3 is a vertical split. The old row-2 source views stay migrated into
// row 1; row 2 now owns the terminal surface directly:
//
//   Row 1: [Open file] [Changes] [Review] [...File/Browser tabs] [+]
//   Row 2: [Setup] [Run action(s)] [Terminal(s)] [+]       [Run] [collapse]
//
// Every worktree carries pinned Changes + Review homes and starts with one
// closable blank File tab. File and Browser tabs are multi-instance and
// removable. Row 2 is a resizable/collapsible TerminalPanel; its Run button
// starts the selected action without changing row 1.
//
// Multi-mount rule: Browsers, Changes, Review, the row-2 TerminalPanel, and a
// bounded set of recent Files stay mounted. Any unsaved File remains mounted
// regardless of recency so switching row-1 tabs cannot destroy its draft.

import React, { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  useColumn3Tabs,
  useActiveColumn3TabId,
  useWorkspaceDispatch,
  useWorkspaceStore,
} from "../zeros/store/store";
import { column3ScopeKey } from "../zeros/store/workspace-store";
import { Column3TabBody } from "./column3-tabs";
import { shouldMountRow1Tab, type Column3Tab } from "./column3-tab-manager";
import {
  isRow1EditorDirty,
  useRow1DirtyEditorIds,
} from "./column3-tabs/code-editor/row1-editor-state";
import { SETUP_SUBTAB } from "./terminal/use-setup-control";
import { Column3TabStrip } from "./column3-tab-strip";
import { Col3ToggleButton } from "./column-toggle-buttons";
import { useTerminalStore } from "./terminal/terminal-store";
import { useColumn3Folder } from "./terminal/use-column3-folder";
import { TerminalPanel } from "./column3-tabs/terminal-tab";
import { TerminalPanelResizer } from "./terminal/terminal-panel-resizer";
import { useTerminalPanelLayoutStore } from "./terminal/terminal-panel-layout";
import { useActiveWorkspace } from "../zeros/store/use-active-workspace";
import {
  clearWorkspaceSettling,
  useWorkspaceSettling,
} from "../zeros/store/pending-workspaces";
import { isLocalMainWorkspace } from "../zeros/store/local-main-workspace";
import {
  invalidateWorkspaceFiles,
  loadWorkspaceFiles,
} from "./workspace-files-cache";
import { ZerosSpinner } from "../loaders";
import { useCustomWindowDrag } from "./use-custom-window-drag";
import { shouldInitializeFreshWorkspace } from "./column3-fresh-workspace";
import { useInstantViewSwitch } from "../zeros/ui/use-instant-view-switch";
import { DiffWorkerPoolProvider } from "./diff-worker-pool";
import { restoreScrollWithin } from "./scroll-memory";
import {
  useRetainedViewKeys,
  useRetainedViewKeySet,
} from "./use-retained-view-keys";
import { PrStatusRow } from "./pr/pr-status-row";

// Proportional columns (2026-07-17): col 3 grows by `(1 - ratio)·100`,
// the complement of col 2's `--zeros-column-2-ratio` grow factor (see
// COL2_DEFAULT_WIDTH_CLS in column2-workspace.tsx) — so a window
// resize/maximize is shared between the two columns in proportion
// instead of flowing entirely into col 3. `flex-basis: 0` lets the
// grow factors decide the split; `min-w-[200px]` floors it. The ×100
// scale keeps the grow sum ≥ 1 so col 3 absorbs ALL the remainder
// when col 2 freezes at its 2400px cap on ultrawide windows (bare
// 0..1 factors leave an empty gap at the right edge there). Flush
// treatment (2026-07-11, replacing the floating islands): the column
// runs edge-to-edge — no gutter, no rounding — with a `border-l`
// seam against col-2. No top inset (2026-07-12): the h-10 header is the
// column's full 0..40px title strip, like col-1 and col-2.
const COL3_CLS =
  "border-border1 relative flex min-h-0 min-w-[200px] flex-col overflow-hidden border-l bg-bg1 [flex:calc((1_-_var(--zeros-column-2-ratio,0.5))*100)_1_0px]";
/** Bound rich File/diff DOM while making the common recent-tab path instant. */
const MAX_RETAINED_ROW1_VIEWS = 6;
/** Iframes are expensive, so preserve the recent cross-workspace working set
 * instead of tying their lifetime to the currently selected worktree. */
const MAX_RETAINED_BROWSER_VIEWS = 8;

interface BrowserViewTarget {
  scope: string;
  tab: Column3Tab;
}

function browserViewKey(scope: string, tabId: string): string {
  return JSON.stringify([scope, tabId]);
}

/** A renderer-wide, bounded iframe deck. Keeping this subscription below the
 * main Column3 component means a hidden workspace's title/URL update does not
 * rerender the active tab strip or source surfaces. */
function RetainedBrowserDeck({
  activeId,
  surfaceActive,
}: {
  activeId: string | null;
  surfaceActive: boolean;
}) {
  const column3ByScope = useWorkspaceStore((state) => state.column3ByScope);
  const activeScope = useWorkspaceStore(column3ScopeKey);
  const targets = useMemo(() => {
    const next = new Map<string, BrowserViewTarget>();
    for (const [scope, slice] of Object.entries(column3ByScope)) {
      for (const tab of slice.tabs) {
        if (tab.type !== "browser") continue;
        next.set(browserViewKey(scope, tab.id), { scope, tab });
      }
    }
    return next;
  }, [column3ByScope]);
  const availableKeys = useMemo(() => new Set(targets.keys()), [targets]);
  const currentBrowserKeys = useMemo(() => {
    const keys: string[] = [];
    for (const [key, target] of targets) {
      if (target.scope === activeScope) keys.push(key);
    }
    const activeKey = activeId ? browserViewKey(activeScope, activeId) : null;
    if (activeKey && availableKeys.has(activeKey)) {
      keys.push(activeKey);
    }
    return keys;
  }, [activeId, activeScope, availableKeys, targets]);
  const retainedKeys = useRetainedViewKeySet(
    currentBrowserKeys,
    MAX_RETAINED_BROWSER_VIEWS,
    availableKeys,
  );

  return retainedKeys.map((key) => {
    const target = targets.get(key);
    if (!target) return null;
    const isActive =
      surfaceActive &&
      target.scope === activeScope &&
      target.tab.id === activeId;
    return (
      <RetainedBrowserView
        key={key}
        scope={target.scope}
        tab={target.tab}
        active={isActive}
      />
    );
  });
}

const RetainedBrowserView = React.memo(function RetainedBrowserView({
  scope,
  tab,
  active,
}: {
  scope: string;
  tab: Column3Tab;
  active: boolean;
}) {
  return (
    <div
      {...(!active ? { inert: "" } : {})}
      className={[
        "absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden",
        active
          ? "pointer-events-auto visible opacity-100"
          : "pointer-events-none invisible opacity-0",
      ].join(" ")}
      aria-hidden={!active}
    >
      <Column3TabBody tab={tab} active={active} scope={scope} />
    </div>
  );
});

// Header: h-10 spans the window's 0..40px title strip so its content centers
// at y=20 — the traffic lights' midline — matching col-1/col-2. The border-b
// (2026-07-14) seats the tab strip on a 1px divider so the header reads as
// the column's chrome band, separate from the tab bodies below.
const COL3_HEADER_CLS =
  "border-border1 flex h-10 shrink-0 items-center gap-1 border-b pr-2";

// Row 1 fills the height row 2 leaves. The seam resizer enforces a usable
// pixel floor while dragging; min-h-0 lets flex resize it without overflow.
const COL3_ROW1_CLS = "flex min-h-0 flex-1 flex-col overflow-hidden bg-bg1";

// ── "Setting up workspace" — the settling window for a fresh create ────────
// While a just-created workspace's surface assembles, both tab rows are
// replaced by a loading row each ("Setting up workspace" + spinner); the real
// strips/tabs mount together in one reveal once the first data is in. The
// window opens before navigation (markWorkspaceSettling in the create surfaces)
// and closes here only after the authoritative workspace row lands and its file
// index either resolves or fails. A timed-out create remains gated until exact
// engine reads confirm publication or rollback.
const SETTLING_SAFETY_TIMEOUT_MS = 8_000;

function SettingUpRow({ grow }: { grow?: boolean }) {
  // Deliberately NO header/tab strip — during setup the row is just a calm
  // centered loader with the label under it (spec: no Open file/Changes/
  // Review strip, no Setup/Run/Terminal strip, nothing else).
  return (
    <div
      className={[
        "bg-bg1 flex min-h-0 flex-col items-center justify-center gap-3 overflow-hidden",
        grow ? "flex-1" : "border-border1 h-[45%] shrink-0 border-t",
      ].join(" ")}
      role="status"
      aria-live="polite"
    >
      <ZerosSpinner size={20} label="Setting up workspace" />
      <span className="text-fg1 text-sm font-medium">Setting up workspace</span>
    </div>
  );
}

// Column 3 can unmount when the whole column is collapsed. Keep the creation
// one-shot at module lifetime so re-expanding within the freshness window does
// not erase a resize/tab choice the user made after the initial landing.
const initializedFreshWorkspaceIds = new Set<string>();
/** Distinguishes a workspace created by this live renderer from one restored by
 * an app restart that happens to be less than 30 seconds after its creation. */
const column3SessionStartedAt =
  typeof performance !== "undefined" && Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin
    : Date.now();

interface Column3Props {
  /** Provided by app-shell — toggles col 3 visibility. Rendered in the
   *  header. */
  onToggleCol3: () => void;
  /** False while the persistent workspace route is hidden behind Home. */
  surfaceActive?: boolean;
  /** Keep the view deck mounted but out of layout while Column 3 is closed. */
  collapsed?: boolean;
}

export function Column3({
  onToggleCol3,
  surfaceActive = true,
  collapsed = false,
}: Column3Props) {
  const tabs = useColumn3Tabs();
  const storedActiveId = useActiveColumn3TabId();
  const dirtyEditorIds = useRow1DirtyEditorIds();
  // The Changes tab's PR status row and the Review tab share one condition:
  // the active workspace has a PR. Tracked here for the creation-moment
  // auto-focus below.
  const { workspace: activeWorkspace, project: activeProject } =
    useActiveWorkspace();
  const refreshWorkspaceId = activeWorkspace
    ? isLocalMainWorkspace(activeWorkspace)
      ? activeWorkspace.repoRoot
      : activeWorkspace.id
    : null;
  const prNumber = activeWorkspace?.prNumber ?? null;

  // Re-validate the stored active id against the tab list: a stale id (including
  // the relocated row-1 Terminal tab) falls back to the first File tab, then
  // Changes, rather than a dead pane.
  const activeId = tabs.some((t) => t.id === storedActiveId)
    ? storedActiveId
    : (tabs.find((t) => t.type === "files")?.id ??
      tabs.find((t) => t.type === "changes")?.id ??
      tabs[0]?.id ??
      null);
  const activeRow1Tab = tabs.find((tab) => tab.id === activeId) ?? null;
  // Changes and Review are retained simultaneously, but their branch chrome
  // must have ONE owner. Mounting PrStatusRow inside both bodies gave each tab
  // an independent React snapshot; whichever tab refreshed last could disagree
  // with the other until its next request settled. Keeping one row above the
  // retained deck makes the status/action identity continuous across the hop.
  const showSharedPrStatusRow =
    !!activeWorkspace &&
    !isLocalMainWorkspace(activeWorkspace) &&
    (activeRow1Tab?.type === "changes" || activeRow1Tab?.type === "review");
  // Recent clean File views join the always-retained Browser/source surfaces;
  // this preserves tree/editor layout without mounting an unbounded tab set.
  const availableRow1Ids = useMemo(
    () => new Set(tabs.map((tab) => tab.id)),
    [tabs],
  );
  const row1IdsToRetain = useRetainedViewKeys(
    activeId,
    MAX_RETAINED_ROW1_VIEWS,
    availableRow1Ids,
  );

  // Window drag + double-click-zoom on the header.
  const headerRef = useRef<HTMLDivElement | null>(null);
  useCustomWindowDrag(headerRef);
  const col3Ref = useRef<HTMLDivElement | null>(null);

  // Collapse hides the whole column with display:none, which clamps every
  // scroller inside to 0 (unlike the visibility-hidden retention pattern the
  // tab decks use). On expand, hand registered scrollers (changes list,
  // review body, file viewers) their offsets back before the frame paints.
  const prevCollapsedRef = useRef(collapsed);
  useLayoutEffect(() => {
    const wasCollapsed = prevCollapsedRef.current;
    prevCollapsedRef.current = collapsed;
    if (wasCollapsed && !collapsed) restoreScrollWithin(col3Ref.current);
  }, [collapsed]);

  const dispatch = useWorkspaceDispatch();

  // ── Auto-focus the Review tab when a PR is CREATED ──────────────────
  // The moment the in-view workspace's prNumber flips null → number, reveal
  // the PR: activate the pinned Review tab (the full review surface; the
  // Changes tab's PR status row lights up on its own) — unless the user is
  // mid-work in column 3: any interaction (click / scroll / typing) in the
  // last few seconds, or unsaved editor changes, suppresses the yank. Only a
  // LIVE transition counts: the first sight of a workspace that already has a
  // PR (boot, workspace switch) is not a creation.
  const { folderKey, chatCwd } = useColumn3Folder();
  useInstantViewSwitch(
    surfaceActive ? `${folderKey}:${activeId ?? "empty"}` : "column3:hidden",
    col3Ref,
  );

  // ── Settling: fresh-create loading rows ──────────────────────────────────
  // The create surface flags the announced worktree path before navigation;
  // the flag is checked against both the workspace row's path and the chat cwd
  // (they are the same string for a fresh create, but the cwd exists in
  // renderer state before the authoritative workspace-list row lands).
  const workspacePath = activeWorkspace?.path ?? null;
  const settlingByPath = useWorkspaceSettling(workspacePath);
  const settlingByCwd = useWorkspaceSettling(chatCwd ?? null);
  const settling = settlingByPath || settlingByCwd;
  const settlingFolder = settlingByPath
    ? workspacePath
    : settlingByCwd
      ? (chatCwd ?? null)
      : null;
  // The reveal requires the workspace ROW to have landed (create RPC resolved
  // + list refetched): settling begins at click time against an announced path,
  // so a premature files read could resolve empty/missing before checkout.
  const settlingRowLanded =
    !!settlingFolder && workspacePath === settlingFolder;
  useEffect(() => {
    if (!settling || !settlingFolder || !settlingRowLanded) return;
    let cancelled = false;
    const reveal = () => {
      if (cancelled) return;
      cancelled = true;
      // Clear every key the flag might live under (path vs cwd spelling).
      clearWorkspaceSettling(settlingFolder);
      if (workspacePath) clearWorkspaceSettling(workspacePath);
      if (chatCwd) clearWorkspaceSettling(chatCwd);
    };
    // Ready = the workspace's file index landed (the slowest first paint in
    // row 1); the timeout guarantees the reveal even if that load fails.
    // Drop any snapshot warmed against the pre-checkout missing path first —
    // serving it would reveal an empty file tree for a populated worktree.
    invalidateWorkspaceFiles(settlingFolder);
    void loadWorkspaceFiles(settlingFolder).then(reveal, reveal);
    const timer = window.setTimeout(reveal, SETTLING_SAFETY_TIMEOUT_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [settling, settlingFolder, settlingRowLanded, workspacePath, chatCwd]);
  const reviewTabId = useMemo(
    () => tabs.find((t) => t.type === "review")?.id ?? null,
    [tabs],
  );
  const reviewTabIdRef = useRef(reviewTabId);
  reviewTabIdRef.current = reviewTabId;
  const lastCol3InteractionRef = useRef(0);
  const markCol3Interaction = () => {
    lastCol3InteractionRef.current = Date.now();
  };
  const seenPrByWorkspace = useRef(new Map<string, number | null>());
  const workspaceId = activeWorkspace?.id ?? null;
  useEffect(() => {
    if (!workspaceId) return;
    const prev = seenPrByWorkspace.current.get(workspaceId);
    seenPrByWorkspace.current.set(workspaceId, prNumber);
    if (prev !== null || prNumber == null) return; // not a live null → PR flip
    const COL3_IDLE_MS = 10_000;
    if (Date.now() - lastCol3InteractionRef.current < COL3_IDLE_MS) return;
    if (isRow1EditorDirty()) return;
    if (reviewTabIdRef.current) {
      dispatch({ type: "ACTIVATE_COLUMN3_TAB", id: reviewTabIdRef.current });
    }
  }, [workspaceId, prNumber, dispatch]);

  // ── New-workspace defaults: Open file + Setup ────────────────────────────
  // A newly-created workspace may reuse stale persisted UI state if its path was
  // used before, so defaults are asserted once after BOTH its createdAt and cwd
  // arrive: row 1 is reset to Open file / Changes / Review with Open file active;
  // row 2 = Setup, expanded. The row-2 height is a single global preference
  // shared across workspaces and repos (like the column widths), so it is
  // deliberately NOT reset here.
  useEffect(() => {
    if (!activeWorkspace) return;
    const id = activeWorkspace.id;
    if (initializedFreshWorkspaceIds.has(id)) return;
    const createdAt = activeWorkspace.createdAt;
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return;
    if (
      !shouldInitializeFreshWorkspace({
        createdAt,
        sessionStartedAt: column3SessionStartedAt,
      })
    ) {
      initializedFreshWorkspaceIds.add(id);
      return;
    }
    // Wait for the real workspace cwd. Marking the id before it arrives would
    // write Setup/height under the temporary "~" fallback and never retry.
    if (!chatCwd) return;
    initializedFreshWorkspaceIds.add(id);
    dispatch({ type: "RESET_COLUMN3_TABS" });
    useTerminalStore.getState().setActiveTerminalTab(folderKey, SETUP_SUBTAB);
    useTerminalPanelLayoutStore.getState().setExpanded(true);
  }, [activeWorkspace, chatCwd, folderKey, dispatch]);

  // Browser iframes live in the renderer-wide bounded deck below. Pinned source
  // views stay alive here. The active File is mounted normally; any OTHER dirty
  // File remains alive invisibly until it is saved or closed. Clean inactive
  // File tabs stay lazy, avoiding N editors doing work on every filesystem
  // refresh just to preserve state they do not have.
  const retainedRow1Set = new Set(row1IdsToRetain);
  const mountedTabs = tabs.filter(
    (tab) =>
      tab.type !== "browser" &&
      (retainedRow1Set.has(tab.id) ||
        shouldMountRow1Tab(tab, activeId, dirtyEditorIds)),
  );

  return (
    // The capture handlers feed the PR-auto-focus idle guard (pointer/scroll/
    // typing anywhere in column 3 = "user is busy here"); events inside the
    // browser tab's iframe don't bubble out, but the iframe keeps its state
    // across a tab switch anyway.
    <DiffWorkerPoolProvider>
      <div
        ref={col3Ref}
        {...(collapsed ? { inert: "" } : {})}
        className={COL3_CLS}
        style={collapsed ? { display: "none" } : undefined}
        aria-hidden={collapsed}
        data-zeros-root=""
        onPointerDownCapture={markCol3Interaction}
        onWheelCapture={markCol3Interaction}
        onKeyDownCapture={markCol3Interaction}
      >
        {settling ? (
          // Fresh create still assembling: BOTH tab rows are replaced by a
          // "Setting up workspace" loading row — no Open file/Changes/Review
          // strip, no Setup/Run/Terminal strip — then everything mounts at
          // once when the settling flag clears (see the reveal effect above).
          <>
            <SettingUpRow grow />
            <SettingUpRow />
          </>
        ) : (
          <>
            {/* ── Row 1: File / Changes / Review + added File/Browser tabs. ── */}
            <div className={COL3_ROW1_CLS}>
              <div ref={headerRef} className={COL3_HEADER_CLS}>
                <div className="h-full min-w-0 flex-1">
                  <Column3TabStrip
                    tabs={tabs}
                    activeId={activeId}
                    folderKey={folderKey}
                    workspaceId={refreshWorkspaceId}
                  />
                </div>
                <Col3ToggleButton
                  col3Collapsed={false}
                  onToggle={onToggleCol3}
                />
              </div>
              {showSharedPrStatusRow && (
                <PrStatusRow
                  workspace={activeWorkspace}
                  originUrl={activeProject?.originUrl ?? null}
                  active={surfaceActive && !collapsed}
                />
              )}
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                {/* Pinned sources and active/dirty File surfaces stay mounted;
                  only the active tab is visible. */}
                {mountedTabs.map((tab) => {
                  const isActive = surfaceActive && tab.id === activeId;
                  return (
                    <div
                      key={tab.id}
                      {...(!isActive ? { inert: "" } : {})}
                      className={[
                        "absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden",
                        isActive
                          ? "pointer-events-auto visible opacity-100"
                          : "pointer-events-none invisible opacity-0",
                      ].join(" ")}
                      aria-hidden={!isActive}
                    >
                      <Column3TabBody
                        tab={tab}
                        active={isActive}
                        scope={folderKey}
                      />
                    </div>
                  );
                })}
                <RetainedBrowserDeck
                  activeId={activeId}
                  surfaceActive={surfaceActive}
                />
              </div>
            </div>
            <TerminalPanelResizer containerRef={col3Ref} />
            <TerminalPanel
              folderKey={folderKey}
              chatCwd={chatCwd}
              surfaceActive={surfaceActive}
            />
          </>
        )}
      </div>
    </DiffWorkerPoolProvider>
  );
}
