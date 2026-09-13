// ──────────────────────────────────────────────────────────
// TerminalPanel — shared terminal controller and retained view deck
// ──────────────────────────────────────────────────────────
// Setup, configured Run actions, and plain shells appear in the main terminal
// sidebar. Selecting a row opens/focuses that destination's own primary tab.
// Each tab can dock independently into the existing resizable bottom panel.
// The renderer moves stable portal hosts between the two surfaces so xterm,
// scrollback, selection, and PTY subscriptions survive a placement change.
// The engine still owns processes. UI navigation never starts a Run action.
// Four workspace folders and twelve session views are retained; hidden views
// remain inert and suspend focus, measurement, shortcuts, and status reads.

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  PanelTop,
  ChevronDown,
  ChevronUp,
  Play,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { type RunAction } from "@zeros/protocol/run-actions";

import { createPortal } from "react-dom";
import { defaultScopeFor } from "../tab-model";
import { workbenchScopeKey } from "../../../state/workspace-store";
import {
  addWorkbenchTerminal,
  openWorkbenchTerminal,
  closeWorkbenchTerminal,
} from "../open-terminal";
import { TerminalPanelResizer } from "../../terminal/terminal-panel-resizer";
import { RetainedTerminalSurface } from "../../terminal/retained-terminal-surface";
import {
  TerminalWorkbenchLayout,
  type TerminalNavigationEntry,
} from "../../terminal/terminal-workbench-layout";
import { useRetainedViewKeySet } from "../../use-retained-view-keys";
import { cn } from "../../../shared/ui/cn";
import { Button } from "../../../shared/ui";
import { Badge, Tooltip } from "../../../shared/ui/primitives";
import { RunWave } from "../../../shared/ui/loading";
import { DynamicIcon } from "../../../shared/ui/icon-registry";
import { useWorkspaceStore } from "../../../state/store";
import { useActiveWorkspace } from "../../../state/use-active-workspace";
import { isLocalMainWorkspace } from "../../../state/local-main-workspace";
import { useNativeRuntime } from "../../../platform/runtime";
import { ptyTerminals, onPtyTerminalsChanged } from "../../../platform/pty";
import {
  workspaceSetupInfo,
  workspaceRunLog,
  type Workspace,
  type WorkspaceRunActionStatus,
  type WorkspaceSetupInfo,
} from "../../../platform/git";
import { useBridge } from "../../../platform/bridge/use-bridge";
import {
  useTerminalStore,
  isRunSessionId,
  isSetupSessionId,
  type TerminalSession,
} from "../../terminal/terminal-store";
import {
  selectExcludedChatTerminalIds,
  selectPanelTerminals,
} from "../../terminal/terminal-registry-sync";
import { TerminalSessionView } from "../../terminal/terminal-session-view";
import { useRunShortcut } from "../../terminal/use-run-shortcut";
import { useRunPreviewUrls } from "../../terminal/use-run-preview-urls";
import { RunSessionButtons } from "../../terminal/run-session-buttons";
import { useOpenBrowserInWorkbench } from "../use-open-browser";
import { prefetchSettingsForRepo } from "../../../features/settings/use-settings";
import { useRunControl } from "../../terminal/use-run-control";
import { useRunStatuses } from "../../terminal/use-run-status";
import { publishRunActivity } from "../../terminal/run-activity-store";
import { SETUP_SUBTAB } from "../../terminal/use-setup-control";
import { useRetainedViewKeys } from "../../use-retained-view-keys";
import { useInstantViewSwitch } from "../../../shared/ui/use-instant-view-switch";
import { RUN_ADD_SUBTAB } from "../../terminal/terminal-tab-selection";
import { useTerminalPanelLayoutStore } from "../../terminal/terminal-panel-layout";
import {
  publishTerminalTabIndicators,
  peekTerminalTabIndicators,
  terminalTabIconName,
} from "../../terminal/terminal-tab-indicators";
import {
  SetupView,
  isSetupOutcome,
  useOpenScriptsSettings,
  type SetupOutcome,
  type SetupViewHandle,
} from "./setup-tab";
import {
  WORKBENCH_TAB_PILL_ACTIVE_CLS,
  WORKBENCH_TAB_PILL_BASE_CLS,
  WORKBENCH_TAB_PILL_INACTIVE_CLS,
} from "../tab-chrome";
import {
  STICKY_TAB_NAV_CLS,
  STICKY_TAB_ROW_CLS,
  STICKY_TAB_VIEWPORT_CLS,
  StickyTabStripFades,
  useStickyTabStrip,
} from "../../use-sticky-tab-strip";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { runOverlayWrapperClass } from "./run-overlay-layout";

/** Sync the engine's SHARED terminal registry into a folder's tab strip:
 *  fetch the terminals the engine knows about, ADD those whose cwd
 *  matches THIS folder, REMOVE any confirmed-then-closed on another device, and
 *  re-sync whenever the set changes anywhere. One controller serves both
 *  terminal placements. Exact-folder readiness gates the auto-seed so we
 *  don't duplicate a terminal another device already opened. */
function useEngineTerminalSync(
  folder: string,
  active: boolean,
): { synced: boolean } {
  const sync = useTerminalStore((s) => s.syncEngineTerminals);
  // Conversation pane terminal-AGENT chats spawn engine PTYs (keyed by CHAT id) into the
  // SAME shared registry. Excluding them here keeps a conversation pane agent terminal from
  // appearing as a PHANTOM tab in this pane; archived terminal chats stay in the
  // set too (a just-closed agent's PTY is reaped async).
  const chatTerminalIds = useWorkspaceStore(
    useShallow((s) => selectExcludedChatTerminalIds(s.chats)),
  );
  const [syncedFolder, setSyncedFolder] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let generation = 0;
    const excluded = new Set(chatTerminalIds);
    const refresh = async () => {
      const request = ++generation;
      const terms = await ptyTerminals();
      if (cancelled || request !== generation) return;
      // null = engine unreachable: don't reconcile (would wrongly prune tabs).
      if (terms !== null) {
        const { inFolder, aliveIds } = selectPanelTerminals(
          terms,
          excluded,
          folder,
        );
        sync(folder, inFolder, aliveIds);
        setSyncedFolder(folder);
      }
    };
    setSyncedFolder(null);
    void refresh();
    const off = onPtyTerminalsChanged(() => void refresh());
    return () => {
      cancelled = true;
      off();
    };
  }, [folder, sync, chatTerminalIds, active]);
  return { synced: syncedFolder === folder };
}

interface TerminalPanelProps {
  workbenchHost: HTMLDivElement | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  folderKey: string;
  chatCwd: string | undefined;
  /** False while the persistent workspace route is hidden behind Home. */
  surfaceActive?: boolean;
}

/** Preserve the common workspace round-trip without attaching every terminal
 * ever opened in a large repository set. */
const MAX_RETAINED_TERMINAL_FOLDERS = 4;
// Literal layout class so Tailwind can emit it. The lockstep source test derives
// these numbers from terminal-panel-layout.ts and fails if either side changes.
const TERMINAL_PANEL_EXPANDED_LAYOUT_CLS =
  "min-h-[140px] [flex-basis:clamp(140px,var(--zeros-terminal-panel-height,50%),calc(100%_-_181px))]";

export function TerminalPanel({
  folderKey,
  chatCwd,
  surfaceActive = true,
  workbenchHost,
  containerRef,
}: TerminalPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [mainBody, setMainBody] = useState<HTMLDivElement | null>(null);
  const [panelBody, setPanelBody] = useState<HTMLDivElement | null>(null);
  const [parking, setParking] = useState<HTMLDivElement | null>(null);
  const setupViewRef = useRef<SetupViewHandle | null>(null);
  const [busySetupOwners, setBusySetupOwners] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const handleSetupBusyChange = useCallback((owner: string, busy: boolean) => {
    setBusySetupOwners((previous) => {
      if (previous.has(owner) === busy) return previous;
      const next = new Set(previous);
      if (busy) next.add(owner);
      else next.delete(owner);
      return next;
    });
  }, []);
  // The chatless workbench owns the ambient tab slice while its PTYs still
  // use the resolved engine folder. Keep UI ownership separate from cwd.
  const scope = useWorkspaceStore(workbenchScopeKey);
  const workbench = useWorkspaceStore(
    (state) => state.workbenchByScope[scope] ?? defaultScopeFor(scope),
  );
  const dispatch = useWorkspaceStore((state) => state.dispatch);
  const mainTab =
    workbench.tabs.find(
      (tab) =>
        tab.id === workbench.activeId &&
        tab.type === "terminal" &&
        tab.terminalPlacement !== "panel",
    ) ?? null;
  const panelTabs = useMemo(
    () =>
      workbench.tabs.filter(
        (tab) => tab.type === "terminal" && tab.terminalPlacement === "panel",
      ),
    [workbench.tabs],
  );
  const panelTab =
    panelTabs.find((tab) => tab.id === workbench.activeTerminalPanelId) ??
    panelTabs[0] ??
    null;
  const dockedIds = useMemo(
    () => new Set(panelTabs.map((tab) => tab.terminalId)),
    [panelTabs],
  );
  const hasPanel = panelTabs.length > 0;
  const { workspace: activeWs } = useActiveWorkspace();
  const expanded = useTerminalPanelLayoutStore(
    (state) => state.layout.expanded,
  );
  const setExpanded = useTerminalPanelLayoutStore((state) => state.setExpanded);

  const allSessions = useTerminalStore((s) => s.sessions);
  const retentionGeneration = useTerminalStore(
    (state) => state.retentionGeneration,
  );
  // Recent workspace terminal grids stay mounted so xterm scrollback, cursor,
  // selection, and fit state survive a workspace round-trip.
  const folderKeysToRender = useRetainedViewKeys(
    folderKey,
    MAX_RETAINED_TERMINAL_FOLDERS,
    undefined,
    String(retentionGeneration),
  );
  // Setup owns an xterm-backed log buffer too. Remember the workspace object
  // for each retained folder so switching workspaces hides that complete view
  // instead of remounting one shared SetupView with a new key.
  const retainedSetupTargetsRef = useRef<
    Array<{ folderKey: string; workspace: Workspace }>
  >([]);
  const setupTargetsToRender = useMemo(() => {
    const allowed = new Set(folderKeysToRender);
    const retainedSetupTargets = retainedSetupTargetsRef.current;
    let next = retainedSetupTargets.filter((target) =>
      allowed.has(target.folderKey),
    );
    if (activeWs) {
      next = [
        ...next.filter((target) => target.folderKey !== folderKey),
        { folderKey, workspace: activeWs },
      ];
    }
    if (
      next.length === retainedSetupTargets.length &&
      next.every(
        (target, index) =>
          target.folderKey === retainedSetupTargets[index]?.folderKey &&
          target.workspace === retainedSetupTargets[index]?.workspace,
      )
    ) {
      return retainedSetupTargets;
    }
    return next;
  }, [activeWs, folderKey, folderKeysToRender]);
  useLayoutEffect(() => {
    retainedSetupTargetsRef.current = setupTargetsToRender;
  }, [setupTargetsToRender]);
  const setupWorkspaceByFolder = useMemo(
    () =>
      new Map(
        setupTargetsToRender.map(
          (target) => [target.folderKey, target.workspace] as const,
        ),
      ),
    [setupTargetsToRender],
  );
  const retainedFolderSet = useMemo(
    () => new Set(folderKeysToRender),
    [folderKeysToRender],
  );
  const folderSessions = useMemo(
    () =>
      allSessions.filter((session) => retainedFolderSet.has(session.folder)),
    [allSessions, retainedFolderSet],
  );
  const availableSessionIds = useMemo(
    () => new Set(folderSessions.map((s) => s.id)),
    [folderSessions],
  );
  const sessionIdsToRetain = useMemo(
    () => [
      ...folderSessions.filter((s) => s.folder === folderKey).map((s) => s.id),
      ...(mainTab?.terminalId ? [mainTab.terminalId] : []),
      ...(panelTab?.terminalId ? [panelTab.terminalId] : []),
    ],
    [folderSessions, folderKey, mainTab?.terminalId, panelTab?.terminalId],
  );
  const retainedSessionIds = useRetainedViewKeySet(
    sessionIdsToRetain,
    12,
    availableSessionIds,
  );
  const retainedSessions = useMemo(() => {
    const ids = new Set(retainedSessionIds);
    return folderSessions.filter((s) => ids.has(s.id));
  }, [folderSessions, retainedSessionIds]);
  const activeRaw = useTerminalStore(
    (state) => state.activeTerminalTabByFolder[folderKey] ?? null,
  );
  const createSession = useTerminalStore((s) => s.createSession);
  const setActiveTerminalTab = useTerminalStore((s) => s.setActiveTerminalTab);

  const nativeReady = useNativeRuntime().ready;
  const { synced: engineSynced } = useEngineTerminalSync(
    folderKey,
    surfaceActive,
  );

  const sessions = useMemo(
    () =>
      allSessions
        .filter((s) => s.folder === folderKey)
        .sort((a, b) => a.createdAt - b.createdAt),
    [allSessions, folderKey],
  );
  const runControl = useRunControl(folderKey, chatCwd);
  const openEnvironment = useOpenScriptsSettings("environment");
  const { actions, actionsReady, runIdFor, startRun, stopRun } = runControl;
  const { statuses: runStatuses, ready: runStatusesReady } = useRunStatuses(
    activeWs,
    folderKey,
    actions,
    surfaceActive,
  );
  const previewUrls = useRunPreviewUrls(
    activeWs?.id ?? null,
    folderKey,
    actions,
    runStatuses,
    surfaceActive,
  );
  const openBrowser = useOpenBrowserInWorkbench();
  const openRunPreview = useCallback(
    (actionId: string) => {
      const url = previewUrls[actionId];
      if (url) openBrowser({ url });
    },
    [openBrowser, previewUrls],
  );
  const anyRunActionRunning = actions.some(
    (action) => runStatuses[action.id]?.state === "running",
  );
  useEffect(() => {
    // Both guards exist for one reason: this publication is AUTHORITATIVE — it
    // supersedes the top bar's own poll for this exact folder — so it must
    // never be made from a placeholder.
    //   • actionsReady: a settings revalidation must not clear a usable signal
    //     merely because its action list is temporarily empty.
    //   • runStatusesReady: the status map reads {} both before the first
    //     workspace.runInfo lands and when nothing is running. Publishing the
    //     first as if it were the second blanks the live wave on this
    //     workspace's own top-bar tab for a round-trip, every cold open.
    if (!actionsReady || !runStatusesReady) return;
    publishRunActivity(folderKey, anyRunActionRunning);
  }, [actionsReady, runStatusesReady, anyRunActionRunning, folderKey]);
  // The Run sub-tab shows its "Add run script" state when the repo (verifiably)
  // defines no actions — the affordance must never fully disappear.
  const showRunAdd = actionsReady && actions.length === 0;

  // The strip lists PLAIN terminals only — the run terminal has its own "Run"
  // tab. (`pty-setup-` ids are the RETIRED trunk inline setup terminals —
  // purged below, and filtered here so a not-yet-purged one never shows.)
  const plainTerminals = useMemo(
    () =>
      sessions.filter((s) => !isRunSessionId(s.id) && !isSetupSessionId(s.id)),
    [sessions],
  );

  // MIGRATION: the trunk's setup used to run in an inline `pty-setup-*`
  // terminal here; it now goes through the engine-backed runner (SetupView),
  // like a worktree. Purge any persisted legacy session so it can't linger as
  // an invisible zombie tab (force: it may be its folder's only session).
  const forceCloseSession = useTerminalStore((s) => s.forceCloseSession);
  useEffect(() => {
    for (const s of sessions) {
      if (isSetupSessionId(s.id)) forceCloseSession(s.id);
    }
    // forceCloseSession defensively selects a surviving plain shell when the
    // deleted session was active. A retired setup id must instead migrate to
    // the first-class Setup tab, including when the id is stale and its session
    // was already absent from persistence.
    if (activeRaw && isSetupSessionId(activeRaw)) {
      setActiveTerminalTab(folderKey, SETUP_SUBTAB);
    }
  }, [sessions, forceCloseSession, activeRaw, setActiveTerminalTab, folderKey]);

  // CLEANUP: a run session whose ACTION was removed from settings has no tab
  // (run ids are filtered from the plain strip and its action tab is gone) —
  // close it so it can't linger as an invisible zombie, killing its PTY if
  // the process is still alive (removing the action means stopping its run).
  // Gated on actionsReady: an empty list during settings load means
  // "unknown", and must not tear down a live dev server.
  useEffect(() => {
    if (!actionsReady) return;
    const valid = new Set(actions.map((a) => runIdFor(a.id)));
    for (const s of sessions) {
      if (isRunSessionId(s.id) && !valid.has(s.id)) forceCloseSession(s.id);
    }
    // closeSession normally chooses a surviving plain shell. When the removed
    // run tab itself was selected, preserve the Run workflow instead: the
    // discoverability tab if none remain, otherwise the first configured run.
    if (activeRaw && isRunSessionId(activeRaw) && !valid.has(activeRaw)) {
      setActiveTerminalTab(
        folderKey,
        showRunAdd
          ? RUN_ADD_SUBTAB
          : actions[0]
            ? runIdFor(actions[0].id)
            : SETUP_SUBTAB,
      );
    }
  }, [
    actionsReady,
    actions,
    runIdFor,
    sessions,
    forceCloseSession,
    activeRaw,
    setActiveTerminalTab,
    folderKey,
    showRunAdd,
  ]);

  const activeSubTab = panelTab?.terminalId ?? SETUP_SUBTAB;
  const isVisible = (folder: string, id: string) =>
    surfaceActive &&
    folder === folderKey &&
    (mainTab?.terminalId === id ||
      (hasPanel && expanded && panelTab?.terminalId === id));
  const targetFor = (folder: string, id: string) => {
    if (folder === folderKey && mainTab?.terminalId === id) return mainBody;
    if (folder === folderKey && panelTab?.terminalId === id) return panelBody;
    return parking;
  };
  useInstantViewSwitch(
    surfaceActive ? `terminal:${folderKey}:${activeSubTab}` : "terminal:hidden",
    panelRef,
  );

  // Auto-seed one PLAIN terminal the first time this pane settles on a folder
  // with none — so terminal panel always has a shell ready. activate=false preserves the
  // Setup default instead of yanking a fresh workspace to the seeded terminal.
  const seededFoldersRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!surfaceActive) return;
    if (seededFoldersRef.current.has(folderKey)) return;
    if (!nativeReady) return; // PTY needs Electron
    if (!engineSynced) return; // don't duplicate another device's terminal
    seededFoldersRef.current.add(folderKey);
    if (plainTerminals.length === 0) {
      createSession(folderKey, null, undefined, undefined, false);
    }
    // plainTerminals.length intentionally not in deps — seed once per folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceActive, folderKey, nativeReady, engineSynced, createSession]);

  const handleAddTerminal = useCallback(
    () => addWorkbenchTerminal(folderKey, "panel", scope),
    [folderKey, scope],
  );
  const handleActivate = useCallback(
    (id: string) => {
      const title =
        id === SETUP_SUBTAB
          ? "Setup"
          : id === RUN_ADD_SUBTAB
            ? "Run"
            : (actions.find((a) => runIdFor(a.id) === id)?.name ??
              sessions.find((s) => s.id === id)?.title ??
              "Terminal");
      openWorkbenchTerminal(folderKey, { terminalId: id, title }, scope);
    },
    [folderKey, sessions, actions, runIdFor, scope],
  );
  const handleActivateSetup = useCallback(
    () => handleActivate(SETUP_SUBTAB),
    [handleActivate],
  );
  const handleActivateRun = useCallback(
    (id: string) => handleActivate(runIdFor(id)),
    [handleActivate, runIdFor],
  );
  const handleActivateRunAdd = useCallback(
    () => handleActivate(RUN_ADD_SUBTAB),
    [handleActivate],
  );
  const handleClose = useCallback(
    (id: string) => {
      const tab = workbench.tabs.find(
        (t) => t.type === "terminal" && t.terminalId === id,
      );
      if (tab) closeWorkbenchTerminal(folderKey, tab.id, id, scope);
      else useTerminalStore.getState().closeSession(id);
    },
    [workbench.tabs, folderKey, scope],
  );
  const revealTerminal = useCallback(
    (id: string, title: string) =>
      openWorkbenchTerminal(folderKey, { terminalId: id, title }, scope),
    [folderKey, scope],
  );
  useRunShortcut({
    control: runControl,
    runStatuses,
    active: surfaceActive,
    onRevealTerminal: revealTerminal,
  });
  // An empty registry/settings snapshot is authoritative only for its exact
  // owner after a successful read. Renames update labels without replacing tabs.
  const terminalTitles = useMemo<Array<[string, string]>>(
    () => [
      [SETUP_SUBTAB, "Setup"],
      ...(showRunAdd ? [[RUN_ADD_SUBTAB, "Run"] as [string, string]] : []),
      ...actions.map((a) => [runIdFor(a.id), a.name] as [string, string]),
      ...plainTerminals.map((s) => [s.id, s.title] as [string, string]),
    ],
    [showRunAdd, actions, runIdFor, plainTerminals],
  );
  useEffect(() => {
    dispatch({
      type: "RECONCILE_WORKBENCH_TERMINALS",
      scope,
      titles: terminalTitles,
      sessionsReady: engineSynced,
      actionsReady,
    });
  }, [dispatch, scope, terminalTitles, engineSynced, actionsReady]);
  // Stable across renders (keyed only by sessionId, passed in) so run-session
  // TerminalSessionViews stay memoized through status polls — an attach-only
  // miss replays the engine's buffered output instead of showing a blank pane.
  const replayTargetsRef = useRef(setupWorkspaceByFolder);
  replayTargetsRef.current = setupWorkspaceByFolder;
  const replayRunOnMiss = useCallback((sessionId: string) => {
    const folder = useTerminalStore
      .getState()
      .sessions.find((s) => s.id === sessionId)?.folder;
    const workspaceId = folder
      ? replayTargetsRef.current.get(folder)?.id
      : undefined;
    return workspaceRunLog({ workspaceId, sessionId })
      .then((r) => r.log || null)
      .catch(() => null);
  }, []);

  const activePlainId = plainTerminals.some((t) => t.id === activeSubTab)
    ? activeSubTab
    : null;

  // The Setup tab's status dot (off-tab signal only — see useSetupTabDot).
  const setupStatus = useSetupStatus(activeWs, surfaceActive);
  const setupDot = useSetupTabDot(
    folderKey,
    setupStatus,
    isVisible(folderKey, SETUP_SUBTAB),
  );
  const setupRunDisabled =
    !activeWs ||
    setupStatus === "running" ||
    busySetupOwners.has(activeWs.id);
  const handleRunSetup = useCallback(() => {
    const control = setupViewRef.current;
    if (!surfaceActive || !control || setupRunDisabled) return;
    // Reveal the existing placement before starting. A delayed completion for
    // this workspace must never navigate away from a newer user selection.
    handleActivateSetup();
    void control.run();
  }, [surfaceActive, setupRunDisabled, handleActivateSetup]);

  const entries: TerminalNavigationEntry[] = terminalTitles.map(
    ([id, title]) => {
      const session = plainTerminals.find((s) => s.id === id);
      const action = actions.find((a) => runIdFor(a.id) === id);
      const status = action ? (runStatuses[action.id] ?? null) : null;
      return {
        id,
        title,
        kind: session ? "terminal" : id === SETUP_SUBTAB ? "setup" : "run",
        runActionId: action?.id,
        previewUrl: action ? previewUrls[action.id] : null,
        icon: terminalTabIconName(id, action?.icon),
        docked: dockedIds.has(id),
        exited: session ? !session.alive : false,
        closable: !!session && plainTerminals.length > 1,
        running: status?.state === "running",
        dot: id === SETUP_SUBTAB ? setupDot : runTabDot(status),
      };
    },
  );
  const panelEntry = entries.find((entry) => entry.id === panelTab?.terminalId);
  useEffect(() => {
    if (!surfaceActive) return;
    // A plain shell's exit does not depend on Run settings/status readiness.
    // While those revalidate, preserve their last confirmed exact-folder dots.
    const previous = peekTerminalTabIndicators(folderKey);
    const runIndicators = actionsReady
      ? actions.map((action) => {
          const id = runIdFor(action.id);
          return [
            id,
            {
              running: runStatusesReady
                ? runStatuses[action.id]?.state === "running"
                : (previous[id]?.running ?? false),
              exited: false,
              dot: runStatusesReady
                ? runTabDot(runStatuses[action.id] ?? null)
                : (previous[id]?.dot ?? null),
              icon: action.icon,
            },
          ];
        })
      : Object.entries(previous).filter(([id]) => isRunSessionId(id));
    publishTerminalTabIndicators(
      folderKey,
      Object.fromEntries([
        [SETUP_SUBTAB, { running: false, exited: false, dot: setupDot }],
        ...runIndicators,
        ...plainTerminals.map((session) => [
          session.id,
          { running: false, exited: !session.alive, dot: null },
        ]),
      ]),
    );
  }, [
    surfaceActive,
    actionsReady,
    runStatusesReady,
    folderKey,
    setupDot,
    actions,
    runIdFor,
    runStatuses,
    plainTerminals,
  ]);
  return (
    <>
      {workbenchHost &&
        createPortal(
          <TerminalWorkbenchLayout
            tab={mainTab}
            entries={entries}
            onSelect={handleActivate}
            onClose={handleClose}
            onAdd={() => addWorkbenchTerminal(folderKey, "tab", scope)}
            onConfigure={openEnvironment}
            onConfigureIntent={() => {
              if (activeWs?.repoRoot)
                prefetchSettingsForRepo(activeWs.repoRoot);
            }}
            onRun={startRun}
            onRunSetup={handleRunSetup}
            setupRunDisabled={setupRunDisabled}
            onStop={stopRun}
            onOpenPreview={openRunPreview}
            onDock={() => {
              if (mainTab?.terminalId)
                openWorkbenchTerminal(
                  folderKey,
                  {
                    terminalId: mainTab.terminalId,
                    title: mainTab.title,
                    placement: "panel",
                  },
                  scope,
                );
            }}
            onToggleSidebar={() => {
              if (mainTab)
                dispatch({
                  type: "UPDATE_WORKBENCH_TAB",
                  scope,
                  id: mainTab.id,
                  updates: {
                    terminalSidebarVisible:
                      mainTab.terminalSidebarVisible === false,
                  },
                });
            }}
            bodyRef={setMainBody}
          />,
          workbenchHost,
        )}
      {hasPanel && <TerminalPanelResizer containerRef={containerRef} />}
      <div
        ref={panelRef}
        style={!hasPanel ? { display: "none" } : undefined}
        data-terminal-panel=""
        aria-expanded={expanded}
        // Collapse and expand SNAP. The panel used to carry
        // `transition-[flex-basis,min-height] duration-300`, which was wrong in
        // three ways at once:
        //   • The body is hidden the instant `expanded` flips, so a collapse
        //     animated an already-empty box shut for 300ms.
        //   • The expo-out curve put ~half the travel in the first frame and
        //     then crawled the last few pixels — read as a jerk, not motion.
        //   • Worst: xterm's ResizeObserver fires on every animated frame while
        //     the panel is visible. One expand measured 14 distinct body
        //     heights, i.e. 14 refits and 14 PTY resizes (SIGWINCH) — the
        //     shell-redraw storm this file's spawn path (see the header note)
        //     was written to avoid. Snapping makes it exactly one.
        className={cn(
          "bg-bg1 flex shrink-0 flex-col overflow-hidden",
          expanded ? TERMINAL_PANEL_EXPANDED_LAYOUT_CLS : "min-h-10 basis-10",
        )}
      >
        <TerminalSubTabStrip
          folderKey={folderKey}
          showSetup={dockedIds.has(SETUP_SUBTAB)}
          showSelection={expanded}
          showRunActivity={surfaceActive}
          setupActive={activeSubTab === SETUP_SUBTAB}
          setupDot={setupDot}
          actions={actions.filter((a) => dockedIds.has(runIdFor(a.id)))}
          showRunAdd={showRunAdd && dockedIds.has(RUN_ADD_SUBTAB)}
          runIdFor={runIdFor}
          runStatuses={runStatuses}
          activeSubTab={activeSubTab}
          terminals={plainTerminals.filter((s) => dockedIds.has(s.id))}
          canCloseTerminal={plainTerminals.length > 1}
          activeTerminalId={activePlainId}
          onActivateSetup={handleActivateSetup}
          onActivateRun={handleActivateRun}
          onActivateRunAdd={handleActivateRunAdd}
          onActivate={handleActivate}
          onClose={handleClose}
          onAdd={handleAddTerminal}
          leading={
            <Tooltip label={expanded ? "Collapse panel" : "Expand panel"}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-fg2 hover:text-fg1 size-7 shrink-0"
                aria-label={expanded ? "Collapse panel" : "Expand panel"}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? (
                  <ChevronDown className="text-fg2" size={14} />
                ) : (
                  <ChevronUp className="text-fg2" size={14} />
                )}
              </Button>
            </Tooltip>
          }
          trailing={
            <>
              {surfaceActive &&
                expanded &&
                panelEntry?.running &&
                panelEntry.runActionId && (
                  <RunSessionButtons
                    title={panelEntry.title}
                    previewUrl={panelEntry.previewUrl}
                    showLabels
                    onOpenPreview={() =>
                      openRunPreview(panelEntry.runActionId!)
                    }
                    onStop={() => stopRun(panelEntry.runActionId!)}
                  />
                )}
              <Tooltip label="Move terminal to tab bar">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Move terminal to tab bar"
                  onClick={() => {
                    if (panelTab?.terminalId)
                      openWorkbenchTerminal(
                        folderKey,
                        {
                          terminalId: panelTab.terminalId,
                          title: panelTab.title,
                          placement: "tab",
                        },
                        scope,
                      );
                  }}
                >
                  <PanelTop className="text-fg2 size-3.5" />
                </Button>
              </Tooltip>
            </>
          }
        />
        <div
          ref={setPanelBody}
          {...(!expanded ? { inert: "" } : {})}
          aria-hidden={!expanded}
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            !expanded && "pointer-events-none invisible",
          )}
        />
      </div>
      <div ref={setParking} hidden {...{ inert: "" }} aria-hidden="true" />
      {/* Recent workspace terminals stay mounted (PTY + xterm survival); only
            the active folder/tab shows. The xterm fits/focuses only while terminal panel
            is expanded, so a collapsed panel doesn't churn layout. */}
      {retainedSessions.map((s) => {
        const isActive = isVisible(s.folder, s.id);
        return (
          <RetainedTerminalSurface
            key={s.id}
            target={targetFor(s.folder, s.id)}
          >
            <div
              data-terminal-session={s.id}
              // Hidden sessions are pinned during seam drags (resize-gesture-
              // freeze.ts). A COLLAPSED panel's layers measure 0-height and
              // are skipped, so dragging the panel open mid-gesture still
              // reveals a live-sized terminal.
              {...(!isActive
                ? { inert: "", "data-zeros-resize-freeze": "" }
                : {})}
              className={cn(
                "absolute inset-0 flex min-h-0 min-w-0 flex-col p-2",
                isActive
                  ? "pointer-events-auto visible"
                  : "pointer-events-none invisible",
              )}
              aria-hidden={!isActive}
            >
              <TerminalSessionView
                sessionId={s.id}
                cwd={s.folder}
                visible={isActive}
                agentId={s.agentId}
                initialCommand={s.initialCommand ?? null}
                // A run terminal's restart affordance is its Rerun button —
                // a key-restart would spawn a plain shell under the run id.
                // attachOnly: its PTY is born only through workspace.startRun;
                // a mount that finds none must not plant a shell there either.
                restartOnKey={!isRunSessionId(s.id)}
                attachOnly={isRunSessionId(s.id)}
                // On an attach-only miss (the run exited before we attached),
                // replay the engine's buffered output so a fast-failing run
                // isn't a blank pane. Run sessions only; stable callback so the
                // memoized view isn't re-rendered by status polls.
                replayOnMiss={
                  isRunSessionId(s.id) ? replayRunOnMiss : undefined
                }
                surfaceToken="--bg1"
              />
            </div>
          </RetainedTerminalSurface>
        );
      })}
      {/* Setup — the engine-backed log / empty-state view, for the trunk and
            worktrees alike (the trunk runs through the same SetupManager now). */}
      {folderKeysToRender.map((setupFolderKey) => {
        const isActive = isVisible(setupFolderKey, SETUP_SUBTAB);
        return (
          <RetainedTerminalSurface
            key={`setup:${setupFolderKey}`}
            target={targetFor(setupFolderKey, SETUP_SUBTAB)}
          >
            <div
              {...(!isActive
                ? { inert: "", "data-zeros-resize-freeze": "" }
                : {})}
              className={cn(
                "absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden",
                isActive
                  ? "pointer-events-auto visible"
                  : "pointer-events-none invisible",
              )}
              aria-hidden={!isActive}
            >
              <SetupView
                ref={setupFolderKey === folderKey ? setupViewRef : undefined}
                workspace={setupWorkspaceByFolder.get(setupFolderKey) ?? null}
                visible={isActive}
                onBusyChange={handleSetupBusyChange}
              />
            </div>
          </RetainedTerminalSurface>
        );
      })}
      {/* Run — the zero-actions "Add run script" state (the affordance
            never fully disappears; also what a removed action falls back to —
            no stale badge/Rerun for a script that no longer exists). */}
      <RetainedTerminalSurface target={targetFor(folderKey, RUN_ADD_SUBTAB)}>
        <div
          {...(!isVisible(folderKey, RUN_ADD_SUBTAB) ? { inert: "" } : {})}
          className={cn(
            "absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden",
            isVisible(folderKey, RUN_ADD_SUBTAB)
              ? "pointer-events-auto visible"
              : "pointer-events-none invisible",
          )}
          aria-hidden={!isVisible(folderKey, RUN_ADD_SUBTAB)}
        >
          <RunAddEmpty />
        </div>
      </RetainedTerminalSurface>
      {/* Run — per-action empty states and completed outcome/Rerun overlays.
          Live preview and Stop controls belong to the active header. */}
      {actions.map((action) => {
        const id = runIdFor(action.id);
        const session = sessions.find((s) => s.id === id) ?? null;
        // Same three conditions every sibling layer uses. `visible` overrides
        // the panel body's `invisible`, so gating on the sub-tab alone left the
        // overlay painting on a collapsing (and then collapsed) panel after its
        // terminal was already hidden — see runOverlayWrapperClass.
        const isActive = isVisible(folderKey, id);
        return (
          <RetainedTerminalSurface
            key={action.id}
            target={targetFor(folderKey, id)}
            overlay
          >
            <div
              {...(!isActive ? { inert: "" } : {})}
              // pointer-events-none even when ACTIVE — this wrapper sits above
              // the run's terminal, so an `auto` here makes the whole pane
              // swallow wheel/click/drag-select. See run-overlay-layout.ts.
              className={runOverlayWrapperClass(isActive)}
              aria-hidden={!isActive}
            >
              <RunActionOverlay
                folderKey={folderKey}
                action={action}
                session={session}
                status={runStatuses[action.id] ?? null}
                visible={isActive}
                onStart={() => startRun(action.id)}
              />
            </div>
          </RetainedTerminalSurface>
        );
      })}
    </>
  );
}

// ── Setup tab status dot ───────────────────────────────────

type SetupStatus = WorkspaceSetupInfo["state"];
const setupStatusCache = new Map<string, SetupStatus>();
const MAX_SETUP_STATUS_SNAPSHOTS = 64;

/** Live setup status for the ACTIVE workspace, independent of SetupView's
 *  visibility — exactly when the off-tab dot matters. Fetched from
 *  `workspace.setupInfo` on mount / workspace
 *  switch, then re-pulled on every DB_CHANGED{workspaces} broadcast — the
 *  engine fires one for each setup transition (running / passed / failed /
 *  stopped), for the trunk and worktrees alike. */
function useSetupStatus(
  workspace: Workspace | null,
  active: boolean,
): SetupStatus {
  const workspaceId = workspace?.id ?? null;
  const repoRoot =
    workspace && isLocalMainWorkspace(workspace)
      ? workspace.repoRoot
      : undefined;
  const bridge = useBridge();
  // Associates the async completion with its workspace so a folder switch can
  // read that folder's last dot immediately without leaking the previous one.
  const [snapshot, setSnapshot] = useState<{
    workspaceId: string;
    status: SetupStatus;
  }>(() => ({
    workspaceId: workspaceId ?? "",
    status: workspaceId ? (setupStatusCache.get(workspaceId) ?? null) : null,
  }));
  useEffect(() => {
    if (!workspaceId || !active) return;
    let cancelled = false;
    // Monotonic pull token: DB_CHANGED can fire back-to-back (running → then
    // passed) and the responses may resolve out of order — only the LATEST
    // issued pull may commit, or the dot could stick on a stale "running".
    let pullGen = 0;
    const pull = async () => {
      const gen = ++pullGen;
      try {
        // statusOnly: skip the log payload + command resolution — this hook
        // only needs the state enum, and it refires on every workspaces
        // broadcast.
        const next = await workspaceSetupInfo({
          workspaceId,
          repoRoot,
          statusOnly: true,
        });
        if (!cancelled && gen === pullGen) {
          setupStatusCache.delete(workspaceId);
          setupStatusCache.set(workspaceId, next.state);
          if (setupStatusCache.size > MAX_SETUP_STATUS_SNAPSHOTS) {
            const oldest = setupStatusCache.keys().next().value as
              | string
              | undefined;
            if (oldest !== undefined) setupStatusCache.delete(oldest);
          }
          setSnapshot({ workspaceId, status: next.state });
        }
      } catch {
        /* bridge not ready / transient — keep what we have */
      }
    };
    void pull();
    const off = bridge?.on("DB_CHANGED", (msg) => {
      const change = msg as { kinds?: unknown; workspaceIds?: unknown };
      const kinds = change.kinds;
      if (!Array.isArray(kinds) || !kinds.includes("workspaces")) return;
      const workspaceIds = Array.isArray(change.workspaceIds)
        ? change.workspaceIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [];
      if (workspaceIds.length > 0 && !workspaceIds.includes(workspaceId))
        return;
      void pull();
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [workspaceId, repoRoot, bridge, active]);
  if (!workspaceId) return null;
  return snapshot.workspaceId === workspaceId
    ? snapshot.status
    : (setupStatusCache.get(workspaceId) ?? null);
}

/** The "Setup" tab's status dot — an OFF-TAB signal only:
 *   • amber while a run is live (a plain "it's still working" mirror),
 *   • green / red for a run that FINISHED while the user was on another
 *     sub-tab (an unseen result — passed vs failed/stopped),
 *   • never shown while the Setup tab is active, and an unseen result clears
 *     the instant the user opens Setup (the in-panel badge takes over).
 *  A result the user watched land on the Setup tab never dots at all. */
function useSetupTabDot(
  folderKey: string,
  status: SetupStatus,
  setupActive: boolean,
): "running" | SetupOutcome | null {
  const [unseen, setUnseen] = useState<SetupOutcome | null>(null);
  const folderRef = useRef(folderKey);
  const prevRef = useRef<SetupStatus>(null);
  useEffect(() => {
    // The dot is a per-workspace, in-session cue — a folder switch resets the
    // edge detector (the first status of a new folder is baseline, not news).
    const sameFolder = folderRef.current === folderKey;
    folderRef.current = folderKey;
    const prev = sameFolder ? prevRef.current : null;
    prevRef.current = status;
    if (!sameFolder || setupActive) {
      setUnseen(null); // switched away, or seen — the in-panel badge conveys it
      return;
    }
    // Any observed change ONTO an outcome counts as an unseen result — not
    // just running→outcome. A fast run can finish between two pulls (the
    // "running" snapshot never commits), e.g. passed→failed on a rerun; only
    // the initial baseline (prev === null) is exempt, so a result restored
    // from a previous session never dots.
    if (prev != null && prev !== status && isSetupOutcome(status)) {
      setUnseen(status);
    }
  }, [folderKey, status, setupActive]);
  if (setupActive) return null;
  if (status === "running") return "running";
  return unseen;
}

// ── Run action states (empty / last-run / status cluster) ──

export type RunOutcome = "finished" | "failed" | "stopped";

/** True for a FINISHED run's state (running excluded). */
export function isRunOutcome(
  state: WorkspaceRunActionStatus["state"] | null | undefined,
): state is RunOutcome {
  return state === "finished" || state === "failed" || state === "stopped";
}

const RUN_BADGE_LABEL: Record<RunOutcome, string> = {
  finished: "Run finished",
  failed: "Run failed",
  stopped: "Run stopped",
};

const RUN_LAST_RUN_COPY: Record<RunOutcome, string> = {
  finished: "Last run finished successfully.",
  failed: "Last run failed.",
  stopped: "Last run was stopped before it finished.",
};

/** Filled outcome badge — 24px, token bg/fg pair, no icon (identical rule to
 *  Setup's; green = finished, red = failed AND stopped per the catalog). */
function RunStatusBadge({ outcome }: { outcome: RunOutcome }) {
  return (
    <Badge
      variant={outcome === "finished" ? "success" : "failure"}
      className="h-6 font-medium select-none"
    >
      {RUN_BADGE_LABEL[outcome]}
    </Badge>
  );
}

const RUN_BADGE_DISMISS_MS = 15_000;

/** The LAST dismissed run outcome badge per (folder, action) — module-level so
 *  a dismissed badge stays dismissed across sub-tab round-trips and bounded
 *  folder-deck eviction. Mirrors Setup's dismissedBadgeByWorkspace. */
const dismissedRunBadge = new Map<string, string>();
const MAX_DISMISSED_RUN_BADGES = 256;

function rememberDismissedRunBadge(slot: string, key: string): void {
  dismissedRunBadge.delete(slot);
  dismissedRunBadge.set(slot, key);
  while (dismissedRunBadge.size > MAX_DISMISSED_RUN_BADGES) {
    const oldest = dismissedRunBadge.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    dismissedRunBadge.delete(oldest);
  }
}

/** True while the badge for `key` should show; the 15s countdown runs only
 *  while the user is actually viewing the tab (`counting`). */
function useAutoDismissRunBadge(
  slot: string,
  key: string | null,
  counting: boolean,
): boolean {
  const [, bump] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    if (!key || !counting) return;
    if (dismissedRunBadge.get(slot) === key) return;
    const id = window.setTimeout(() => {
      rememberDismissedRunBadge(slot, key);
      bump();
    }, RUN_BADGE_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [slot, key, counting]);
  return key != null && dismissedRunBadge.get(slot) !== key;
}

/** Everything overlaid on ONE action's Run surface:
 *   • no session + no result   → "Start …" empty state
 *   • no session + last result → Setup-style last-run layout (badge pinned
 *                                 bottom-right, "Run again")
 *   • no session + running     → "Starting …" beat (engine spawned it; the
 *                                 registry sync is about to attach the tab)
 *   • session + running        → output only; live controls stay in the header
 *   • session + outcome        → bottom-right badge (auto-dismiss 15s after
 *                                 viewed; "stopped" persists) + 24px "Rerun" */
function RunActionOverlay({
  folderKey,
  action,
  session,
  status,
  visible,
  onStart,
}: {
  folderKey: string;
  action: RunAction;
  session: TerminalSession | null;
  status: WorkspaceRunActionStatus | null;
  visible: boolean;
  onStart: () => void;
}) {
  const state = status?.state ?? null;
  const running = state === "running";
  const outcome: RunOutcome | null = isRunOutcome(state) ? state : null;

  // A NEW run resets this action's badge dismissal — its outcome deserves its
  // own 15s.
  const slot = `${folderKey}\n${action.id}`;
  useEffect(() => {
    if (running) dismissedRunBadge.delete(slot);
  }, [running, slot]);
  const dismissKey =
    session && outcome && outcome !== "stopped"
      ? `${outcome}:${status?.endedAt ?? 0}`
      : null;
  const badgeVisible = useAutoDismissRunBadge(slot, dismissKey, visible);

  if (!session) {
    return (
      // Full-cover AND clickable: with no run terminal mounted there is nothing
      // underneath to reach, and the "Start …" button is the whole point of the
      // state. (The wrapper above is pointer-events-none, so each branch opts
      // itself back in — see the note there.)
      <div className="pointer-events-auto absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden">
        {running ? (
          <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
            <ZerosSpinner size={16} />
            <div className="text-fg2 text-xs">Starting {action.name}…</div>
          </div>
        ) : (
          <>
            <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
              <DynamicIcon
                name={action.icon}
                className="text-muted-fg size-10"
                strokeWidth={1}
                aria-hidden
              />
              <Tooltip label={action.command}>
                <Button variant="secondary" size="sm" onClick={onStart}>
                  {outcome && <RotateCw />}
                  {outcome
                    ? `Run ${action.name} again`
                    : `Start ${action.name}`}
                </Button>
              </Tooltip>
              <div className="text-muted-fg max-w-sm truncate font-mono text-xs">
                {outcome ? RUN_LAST_RUN_COPY[outcome] : action.command}
              </div>
            </div>
            {outcome && (
              <div className="absolute right-3 bottom-3">
                <RunStatusBadge outcome={outcome} />
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  if (running) return null;

  // Session exists → the terminal renders underneath. Return ONLY the
  // bottom-right cluster: a content-sized box, not a full-cover one made
  // click-through again. Every rect that exists is a rect that can swallow the
  // terminal's wheel/selection events, so the safest overlay is the one that
  // isn't there.
  return (
    <div className="pointer-events-auto absolute right-3 bottom-3 flex items-center gap-2">
      {outcome && (outcome === "stopped" || badgeVisible) && (
        <RunStatusBadge outcome={outcome} />
      )}
      <Button variant="secondary" size="sm" onClick={onStart}>
        <RotateCw />
        Rerun
      </Button>
    </div>
  );
}

/** The Run sub-tab's body when no run actions are configured: the
 *  affordance stays discoverable — illustration → "Add run script" (opens
 *  Settings → Run actions) → one-line description. Also the state a repo
 *  falls back to when its last action is REMOVED: no stale outcome badge or
 *  Rerun for a script that no longer exists. */
function RunAddEmpty() {
  const openRunActions = useOpenScriptsSettings("run-actions");
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
      <Play className="text-muted-fg size-10" strokeWidth={1} aria-hidden />
      <Button variant="secondary" size="sm" onClick={() => openRunActions()}>
        Add run script
      </Button>
      <div className="text-fg2 max-w-sm text-xs">
        Run a dev server or test command in this workspace.
      </div>
    </div>
  );
}

/** A completed action keeps its compact outcome dot. Live waves appear in the
 *  primary tabs and sidebar; bottom-panel tab labels remain text. */
function runTabDot(
  status: WorkspaceRunActionStatus | null,
): SetupOutcome | null {
  if (status?.state === "finished") return "passed";
  if (status?.state === "failed") return "failed";
  return null;
}

// ── Sub-tab strip ──────────────────────────────────────────

/** Terminal panel's header: Setup · action(s) · Terminal(s) · [+], using the same pill
 *  geometry and selected background as workbench. Setup + run actions carry no ✕;
 *  a plain terminal shows ✕ on hover once there is more than one (the last
 *  terminal can't be closed). The fixed right edge owns undock and collapse,
 *  while only the tab area scrolls. Sticky strip (use-sticky-tab-strip.tsx):
 *  the "+" stays fixed after the lane, and the ACTIVE pill pins to whichever
 *  lane edge it reaches so the selection can never scroll out of view. */
function TerminalSubTabStrip({
  folderKey,
  showSetup,
  canCloseTerminal,
  showSelection,
  showRunActivity,
  setupActive,
  setupDot,
  actions,
  showRunAdd,
  runIdFor,
  runStatuses,
  activeSubTab,
  terminals,
  activeTerminalId,
  onActivateSetup,
  onActivateRun,
  onActivateRunAdd,
  onActivate,
  onClose,
  onAdd,
  leading,
  trailing,
}: {
  /** The strip's workspace — a switch restarts the scroll at the leading
   *  edge instead of leaking the previous workspace's offset. */
  folderKey: string;
  showSetup: boolean;
  canCloseTerminal: boolean;
  /** A collapsed row keeps its tabs usable but intentionally shows no selected
   *  pill; activating any tab expands and reveals its body. */
  showSelection: boolean;
  showRunActivity: boolean;
  setupActive: boolean;
  /** Off-tab setup status dot (amber running / green passed / red failed or
   *  stopped); null while Setup is active or there's nothing to signal. */
  setupDot: "running" | SetupOutcome | null;
  actions: RunAction[];
  /** Render the zero-actions "Run" tab (the "Add run script" state). */
  showRunAdd: boolean;
  runIdFor(actionId: string): string;
  runStatuses: Record<string, WorkspaceRunActionStatus>;
  activeSubTab: string;
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  onActivateSetup(): void;
  onActivateRun(actionId: string): void;
  onActivateRunAdd(): void;
  onActivate(id: string): void;
  onClose(id: string): void;
  onAdd(): void;
  leading: ReactNode;
  trailing: ReactNode;
}) {
  // A collapsed row shows no selection, so nothing pins or auto-reveals
  // either; re-expanding restores both for the resolved active sub-tab.
  const strip = useStickyTabStrip({
    activeKey: showSelection ? activeSubTab : null,
    resetKey: folderKey,
    tabCount:
      Number(showSetup) +
      actions.length +
      (showRunAdd ? 1 : 0) +
      terminals.length,
    tabAttr: "data-terminal-tab",
  });

  return (
    <div className="border-border1 bg-bg1 @container/terminal-header flex h-10 shrink-0 items-center border-b pr-2 pl-1">
      {leading}
      <div className="flex h-full min-w-0 flex-1 items-center">
        <div className={STICKY_TAB_VIEWPORT_CLS}>
          <div
            ref={strip.navRef}
            className={STICKY_TAB_NAV_CLS}
            role="tablist"
            aria-label="Terminal panel tabs"
            {...strip.navProps}
          >
            <div className={STICKY_TAB_ROW_CLS}>
              {showSetup && (
                <SubTab
                  label="Setup"
                  active={showSelection && setupActive}
                  dot={setupDot}
                  onActivate={onActivateSetup}
                  registerRef={(node) => strip.registerTab(SETUP_SUBTAB, node)}
                />
              )}
              {actions.map((action) => {
                const status = runStatuses[action.id] ?? null;
                return (
                  <SubTab
                    key={action.id}
                    label={action.name}
                    // Selected before its terminal exists too: the body is its
                    // Start state until the explicit Run action begins.
                    active={
                      showSelection && activeSubTab === runIdFor(action.id)
                    }
                    running={showRunActivity && status?.state === "running"}
                    dot={status?.state === "running" ? null : runTabDot(status)}
                    onActivate={() => onActivateRun(action.id)}
                    registerRef={(node) =>
                      strip.registerTab(runIdFor(action.id), node)
                    }
                  />
                );
              })}
              {showRunAdd && (
                <SubTab
                  label="Run"
                  active={showSelection && activeSubTab === RUN_ADD_SUBTAB}
                  onActivate={onActivateRunAdd}
                  registerRef={(node) =>
                    strip.registerTab(RUN_ADD_SUBTAB, node)
                  }
                />
              )}
              {terminals.map((terminal) => (
                <SubTab
                  key={terminal.id}
                  label={terminal.title}
                  active={showSelection && activeTerminalId === terminal.id}
                  exited={!terminal.alive}
                  onActivate={() => onActivate(terminal.id)}
                  // The last terminal can't be closed (the "at least one" rule).
                  onClose={
                    canCloseTerminal ? () => onClose(terminal.id) : undefined
                  }
                  registerRef={(node) => strip.registerTab(terminal.id, node)}
                />
              ))}
            </div>
          </div>
          <StickyTabStripFades fades={strip.fadeRefs} />
        </div>
        {/* The "+" sits OUTSIDE the scroll lane: it hugs the last tab while
            they fit, then stays put while only the tabs scroll. */}
        <div className="flex h-full shrink-0 items-center">
          <Tooltip label="New terminal">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-fg2 hover:text-fg1 size-7 shrink-0"
              aria-label="New terminal"
              onClick={onAdd}
            >
              <Plus className="text-fg2" size={14} />
            </Button>
          </Tooltip>
        </div>
        <div className="min-w-0 flex-1" aria-hidden="true" />
      </div>
      <div className="ml-1 flex shrink-0 items-center gap-1">{trailing}</div>
    </div>
  );
}

/** One terminal panel pill. Shared chrome constants keep it identical to workbench while
 *  preserving terminal-only status, exited, and close behaviors. */
function SubTab({
  label,
  active,
  exited,
  running,
  dot,
  onActivate,
  onClose,
  registerRef,
}: {
  label: string;
  active: boolean;
  exited?: boolean;
  running?: boolean;
  dot?: "running" | SetupOutcome | null;
  onActivate(): void;
  onClose?(): void;
  /** Registers the pill with the sticky strip (pin math + reveal). */
  registerRef(node: HTMLDivElement | null): void;
}) {
  return (
    <div
      ref={registerRef}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      data-active={active}
      data-terminal-tab="true"
      className={cn(
        "group/subtab gap-0 px-2.5",
        WORKBENCH_TAB_PILL_BASE_CLS,
        active
          ? WORKBENCH_TAB_PILL_ACTIVE_CLS
          : WORKBENCH_TAB_PILL_INACTIVE_CLS,
      )}
    >
      {running && <RunWave size={12} className="mr-1.5" />}
      <span className="max-w-[140px] truncate">
        {label}
        {exited && <span className="ml-1 opacity-70">(exited)</span>}
      </span>
      {dot && (
        <span
          aria-hidden
          className={cn(
            "ml-1.5 size-1.5 shrink-0 rounded-full",
            dot === "running" &&
              "bg-yellow-primary ring-yellow-primary/20 ring-[3px]",
            dot === "passed" && "bg-green-primary",
            (dot === "failed" || dot === "stopped") && "bg-red-primary",
          )}
        />
      )}
      {onClose && (
        <>
          {/* Fade gradient — masks the trailing edge of the label so the close
              button sits on a clean fade-out instead of chopping the text.
              The tab is bg2 whenever active/hovered, matching workbench. Pure overlay
              (absolute) → no flex-width change on hover, no layout shift, so the
              label keeps its full footprint at rest. Reveal keys off the
              strip-driven data-hovered, not :hover (sticky-strip rule). */}
          <span
            aria-hidden
            className="from-bg2 pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-50% to-transparent opacity-0 transition-none group-data-[hovered=true]/subtab:opacity-100"
          />
          <button
            type="button"
            aria-label={`Close ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className={cn(
              "absolute top-1/2 right-1 inline-flex size-4 -translate-y-1/2 items-center justify-center",
              // Solid backing matches the selected/hovered pill so the X is never read
              // against the label underneath; hover bumps to bg-bg2-hover for feedback.
              "bg-bg2 text-fg2 hover:bg-bg2-hover hover:text-fg1 rounded-sm",
              "opacity-0 transition-none group-data-[hovered=true]/subtab:opacity-100",
              // Keyboard focus visibility — the absolute button is otherwise
              // invisible to tab-key users since opacity:0 kills paint + a11y.
              "focus-visible:ring-highlighted-bright focus-visible:opacity-100 focus-visible:ring-1 focus-visible:outline-none",
            )}
          >
            <X size={10} />
          </button>
        </>
      )}
    </div>
  );
}
