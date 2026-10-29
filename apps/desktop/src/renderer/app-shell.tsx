import { subscribeChatSnapshots } from "./state/chat-snapshot-subscription";

import React, { useEffect, useRef } from "react";
import { CloudWorkspaceLifecycle } from "./state/cloud-workspace-lifecycle";
import { canBackgroundSyncCloudWorkspace } from "./state/cloud-workspace-catalog";
import { isCloudWorkspace } from "./platform/bridge/cloud-workspace-key";
import {
  useChats,
  useActiveChatId,
  useActivePage,
  useActiveRepoId,
  useCreateWorkspaceProjectId,
  useWorkspaceDispatch,
  useWorkspaceStore,
  normalizeChatPermissionMode,
  type ChatThread,
} from "./state/store";
import { resolveBootActiveChatId } from "./state/boot-active-chat";
import { sanitizeChatDirectories } from "./state/chat-boot-cache";
import {
  canMirrorChat,
  reconcileChatSnapshot,
  samePersistedChat,
} from "./state/chat-reconciliation";
import { hydrateAiApiKey } from "./shared/lib/openai";
import { startPersonalPreferencesSync } from "./features/settings/personal-preferences-sync";
import { startAgentPreferencesSync } from "./features/settings/agent-preferences-sync";
import {
  BridgeProvider,
  useBridge,
  useExtensionConnected,
} from "./platform/bridge/use-bridge";
import {
  ensureEnvSecretsInVault,
  ensureSettingsTomlMigrated,
  pruneRetiredProviders,
} from "./features/settings/migrate-legacy";
import { AgentSessionsProvider } from "./features/agent/sessions-provider";
import { startChatUnreadTracking } from "./features/agent/chat-unread";
import { requestAiChatTitle } from "./features/agent/chat-title";
import { startChatTitleBackfill } from "./features/agent/chat-title-backfill";
import { bridgeChatTitleSeedsByOwner } from "./platform/bridge/workspace-bridge";
import { useAgentSessions } from "./features/agent/sessions-hooks";
import {
  getAgentsSnapshot,
  hasConfirmedAgents,
  loadAgents,
} from "./features/agent/agents-cache";
import { migrateDefaultModelSelection } from "./features/agent/model-favorites";
import { UpdateNotifications } from "./features/update/update-notifications";
import { useCopyLogsHotkey } from "./shell/use-copy-logs-hotkey";
import { useNewTabHotkeys } from "./shell/use-new-chat-hotkey";
import { useOpenBrowserHotkey } from "./shell/use-open-browser-hotkey";
import { useShortcutsHotkey } from "./shell/use-shortcuts-hotkey";
import { ShortcutsPalette } from "./shell/shortcuts-palette";
import { CommandPaletteController } from "./shell/command-palette-controller";
import { useCommandPaletteHotkey } from "./shell/use-command-palette-hotkey";
import { FeedbackDialog } from "./shell/dialogs/feedback-dialog";
import { onFeedbackDialogRequest } from "./shell/feedback-controller";
import {
  nextWorkbenchColumnState,
  onWorkbenchCollapseRequest,
  onWorkbenchRestoreRequest,
  persistedWorkbenchCollapsed,
  type WorkbenchColumnEvent,
  type WorkbenchColumnState,
} from "./shell/workbench/workbench-visibility-controller";
import { isFeedbackConfigured } from "./features/feedback/submit-feedback";
import { BrowserConfirmationController } from "./features/browser/browser-confirmation-controller";
import { AgentControlConfirmationController } from "./features/agent-control/agent-control-confirmation-controller";
import { ComputerUseController } from "./features/agent-control/computer-use-controller";
import { SimulatorController } from "./features/simulators/simulator-controller";
import { SimulatorAgentController } from "./features/simulators/simulator-agent-controller";
import { BrowserSessionController } from "./features/browser/browser-session-controller";
import { KeepAwakeController } from "./features/settings/keep-awake-controller";
import { BrowserAgentPictureInPicture } from "./features/browser/browser-agent-picture-in-picture";
import { AppSidebar } from "./shell/app-sidebar";
import { useSidebarCollapsed } from "./shell/sidebar-collapsed";
import { CollapsedSidebarControls } from "./shell/sidebar-toggle";
import { ConversationPane } from "./shell/conversation/conversation-pane";
import { WorkbenchPane } from "./shell/workbench/workbench-pane";
import { useWorkspacePrSync } from "./shell/pr/use-workspace-pr-sync";
import { useProjectCapabilitiesRefresh } from "./shell/use-project-capabilities-refresh";
import { useEditHistoryMenu } from "./shell/use-edit-history-menu";
import { workspaceIsReadOnly } from "./state/workspace-history";
import {
  AddProjectProvider,
  useAddProject,
} from "./shell/add-project-provider";
import { DispatcherPage } from "./shell/dispatcher/dispatcher-modal";
import { NoProjectsView } from "./shell/no-projects-view";
import { useActiveWorkspace } from "./state/use-active-workspace";
import { LocalLinkNavigation } from "./shell/local-link-navigation";
import { useProjects } from "./state/use-projects";
import { SettingsPage } from "./features/settings/settings-page";
import { DashboardPage } from "./features/dashboard/dashboard-page";
import { CustomizePage } from "./features/agent-extensions/customize-page";
import { RepoPage } from "./features/repositories/repo-page";
import { useWarmAutomaticRepositoryIcons } from "./features/repositories/repository-icons";
import { onProjectChanged } from "./platform/app";
import {
  loadStickyDefaults,
  saveStickyDefaults,
} from "./shell/sticky-defaults";
import { isEditableHotkeyTarget } from "./shell/editable-target";
import { getSetting, setSetting } from "./platform/settings";
import {
  useInviteDeepLink,
  clearPendingInviteToken,
} from "./features/team/invite-link";
import {
  requestTeamResync,
  useTeamEngineSync,
} from "./features/team/team-sync";
import { refreshTeams } from "./features/team/team-store";
import { useAuth } from "./features/auth";
import { nativeListen } from "./platform/runtime";
import { rememberProject } from "./platform/recent-projects";
import {
  dbReplaceAllChats,
  dbClearChatProviderIdentity,
  dbDeleteChat,
  type ChatRowWire,
} from "./features/agent/agent-history-client";
import {
  persistChatRowsWithBestEffortIdentityClears,
  providerIdentityClearForTransition,
} from "./features/agent/chat-provider-identity-persistence";
import {
  loadScrollPositions,
  pruneScrollPositions,
} from "./features/agent/device-local";
import { useSessionsStore } from "./features/agent/sessions-store";
import {
  claimAgentPrewarmForEngineSession,
  prewarmAgentOnce,
  resetAgentPrewarmForEngineSession,
} from "./features/agent/agent-prewarm-singleflight";
import { AnalyticsBoot } from "./platform/observability/analytics/boot";
import { AppearanceProvider } from "./shared/theme/provider";
import { getVariant, setPrefs } from "./shared/theme/store";
import { AuthProvider, AuthGate } from "./features/auth";
import { Toaster } from "./shared/ui/primitives/elements";
import { TooltipProvider } from "./shared/ui/primitives/tooltip";
import { useInstantViewSwitch } from "./shared/ui/use-instant-view-switch";
import {
  useRetainedViewKeys,
} from "./shell/use-retained-view-keys";
import { useGitRefreshCoordinator } from "./shell/use-git-refresh-key";
import { GithubAppNotifications } from "./platform/bridge/github-app-notifications";

// Shared with the repo-removal path so both reconcile exactly the same keys; a
// drifted key would resurrect deleted chats on reload.
import {
  CHATS_BACKUP_KEY,
  CHATS_STORAGE_KEY,
  CHATS_TOMBSTONE_KEY,
} from "./state/chats-local-cache";

import { popoverBoundaryProps } from "@/renderer/shared/ui/popover-boundary";
import { persistWorkspaceChatCache } from "./state/cloud-chat-cache";
import { accountPresentationGeneration } from "./platform/account-presentation-cache";
import { installAccountPresentationIdentity } from "./state/account-presentation";
import { localTranscriptCache } from "./state/local-transcript-cache";
import { retainTranscriptSummaries } from "./features/agent/use-chat-transcript-summaries";
import { retainKnownEmptyLocalChats } from "./features/agent/fresh-local-chats";

// Device-local scroll positions must exist before the first chat layout effect;
// a passive ChatsPersistence effect is already too late and causes a visible
// snap-to-bottom followed by restoration. This cache read is synchronous,
// validated by the sessions store, and does no bridge/native work.
try {
  useSessionsStore.getState().seedScrollPositions(loadScrollPositions());
} catch (err) {
  console.warn("[Zeros] scroll-position boot hydration failed:", err);
}

/** Pre-warm agent subprocesses once per engine session so the first real
 *  session skips cold start: the active chat's agent, then agents attached to
 *  chats, then every enabled registry agent. Fire-and-forget; already-warm
 *  agents are skipped. */
function PreWarmAgents() {
  const chats = useChats();
  const activeChatId = useActiveChatId();
  const sessions = useAgentSessions();
  const engineReady = useExtensionConnected();

  const warmAll = React.useCallback(async () => {
    try {
      // A confirmed stale-while-revalidate snapshot is enough to choose which
      // providers to initialize. Do not turn every engine reconnect into a
      // synchronous auth/version probe sweep: those provider subprocesses and
      // utility canaries otherwise compete with the active chat's cold resume.
      // A genuinely fresh data dir still loads the registry here; settled chat
      // and Settings surfaces refresh an existing snapshot later.
      const snapshot = getAgentsSnapshot();
      const registry =
        snapshot && hasConfirmedAgents()
          ? snapshot
          : await loadAgents((force) => sessions.listAgents(force));
      // Chat rows can name agents the registry no longer has (deprecated ids,
      // terminal-only agents such as amp); never init those.
      const registryIds = new Set(registry.map((a) => a.id));

      const order: string[] = [];
      const active = chats.find((c) => c.id === activeChatId);
      if (active?.agentId && registryIds.has(active.agentId)) {
        order.push(active.agentId);
      }
      for (const c of chats) {
        if (
          c.agentId &&
          registryIds.has(c.agentId) &&
          !order.includes(c.agentId)
        ) {
          order.push(c.agentId);
        }
      }
      for (const a of registry) {
        if (a.authenticated === true && !order.includes(a.id)) order.push(a.id);
      }

      // warmAgentIds clears on disposeAll (engine restart), so a focus re-warm only
      // retries agents that need it.
      const warm = useSessionsStore.getState().warmAgentIds;
      const needsWarm = order.filter((id) => !warm.has(id));
      if (needsWarm.length === 0) return;

      await Promise.all(
        needsWarm.map((id) =>
          prewarmAgentOnce(id, sessions.initAgent).catch((err) => {
            // Best-effort: log at debug and let the next prompt surface a real failure
            // through ensureSession.
            console.debug(
              `[Zeros] prewarm initAgent failed for ${id}:`,
              err instanceof Error ? err.message : err,
            );
          }),
        ),
      );
    } catch {
      /* registry unreachable — real session flow still recovers */
    }
  }, [sessions, chats, activeChatId]);

  // One warmup per engine session. The claim lives in
  // agent-prewarm-singleflight's renderer-global state, because Vite re-evaluates
  // an edited module, and resets only when the engine dies.
  useEffect(() => {
    if (!engineReady) {
      resetAgentPrewarmForEngineSession();
      return;
    }
    if (!claimAgentPrewarmForEngineSession()) return;
    void warmAll();
  }, [engineReady, warmAll]);

  // Re-warm on focus, throttled: while backgrounded, the engine may have cycled or
  // agents exited on idle. warmAll skips warm agents, so this is usually a no-op.
  useEffect(() => {
    if (!engineReady) return;
    let lastRun = 0;
    const onFocus = () => {
      const now = Date.now();
      if (now - lastRun < 10_000) return;
      lastRun = now;
      void warmAll();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [engineReady, warmAll]);

  return null;
}

/** The OpenAI API key lives in the macOS keychain, not localStorage, so it is
 *  merged into AiSettings a tick after boot. */
function HydrateAiApiKey() {
  const dispatch = useWorkspaceDispatch();
  useEffect(() => {
    let cancelled = false;
    hydrateAiApiKey(useWorkspaceStore.getState().aiSettings).then(
      (hydrated) => {
        if (cancelled) return;
        if (
          hydrated.apiKey &&
          hydrated.apiKey !== useWorkspaceStore.getState().aiSettings.apiKey
        ) {
          dispatch({ type: "SET_AI_SETTINGS", settings: hydrated });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** ChatThread → SQLite wire row. Every field stays JSON-safe, so IPC needs no
 *  custom serializer. */
function threadToRow(c: ChatThread): ChatRowWire {
  return {
    id: c.id,
    folder: c.folder ?? "",
    agentId: c.agentId ?? null,
    agentName: c.agentName ?? null,
    model: c.model ?? null,
    effort: c.effort,
    permissionMode: c.permissionMode,
    lastModeId: c.lastModeId ?? null,
    prePlanModeId: c.prePlanModeId ?? null,
    fast: !!c.fast,
    additionalDirectories: sanitizeChatDirectories(c.additionalDirectories),
    title: c.title ?? "",
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    sessionId: c.sessionId ?? null,
    providerBinding: c.providerBinding ?? null,
    providerMetadata: c.providerMetadata ?? null,
    pinned: !!c.pinned,
    archived: !!c.archived,
    sourceChatId: c.sourceChatId ?? null,
    kind: c.kind ?? null,
  };
}

function rowToThread(r: ChatRowWire): ChatThread {
  const validEffort = [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultracode",
  ] as const;
  type Effort = (typeof validEffort)[number];
  const effort: Effort = (validEffort as readonly string[]).includes(r.effort)
    ? (r.effort as Effort)
    : "high";
  // Normalize the persisted posture, migrating the legacy vocabulary
  // (full/auto-edit/ask/plan-only) to the current one.
  const permissionMode = normalizeChatPermissionMode(r.permissionMode);
  // The wire widens `kind` to a nullable string so legacy rows round-trip;
  // anything else becomes undefined (== "chat").
  const resolvedKind: "chat" | "terminal" | undefined =
    r.kind === "terminal" || r.kind === "chat" ? r.kind : undefined;
  const providerBinding =
    r.providerBinding?.providerId === r.agentId ? r.providerBinding : undefined;
  return {
    id: r.id,
    composerMode: r.composerMode === "design" ? "design" : "code",
    composerModeRevision: Number.isSafeInteger(r.composerModeRevision) && r.composerModeRevision! >= 0 ? r.composerModeRevision : 0,
    folder: r.folder,
    agentId: r.agentId,
    agentName: r.agentName,
    model: r.model,
    effort,
    permissionMode,
    // Exact mode ids round-trip as-is (string|null) — they're validated against
    // the live agent's advertised modes at reconcile time, not here.
    ...(r.lastModeId ? { lastModeId: r.lastModeId } : {}),
    ...(r.prePlanModeId ? { prePlanModeId: r.prePlanModeId } : {}),
    fast: !!r.fast,
    additionalDirectories: sanitizeChatDirectories(r.additionalDirectories),
    title: r.title,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    sessionId: r.sessionId ?? undefined,
    providerBinding,
    providerMetadata: providerBinding
      ? (r.providerMetadata ?? undefined)
      : undefined,
    pinned: r.pinned,
    archived: r.archived,
    sourceChatId: r.sourceChatId ?? undefined,
    kind: resolvedKind,
  };
}

/** Marks chats unread when their agent finishes off screen, for the whole
 *  app session (chat-unread.ts). */
function ChatUnreadTracking() {
  useEffect(() => startChatUnreadTracking(), []);
  return null;
}

/** Names Untitled Local chats that are not on screen — agent-started tabs,
 *  background tabs, long reopened chats (chat-title-backfill.ts). The chat
 *  surface names the one in view; both share one deduplicated request. */
function ChatTitleBackfill() {
  const bridge = useBridge();
  const dispatch = useWorkspaceDispatch();
  useEffect(() => {
    if (!bridge || bridge.executionIdentity.kind !== "local") return;
    return startChatTitleBackfill({
      getChats: () => useWorkspaceStore.getState().chats,
      subscribeChats: (listener) =>
        useWorkspaceStore.subscribe((state, previous) => {
          if (state.chats !== previous.chats) listener();
        }),
      onDbChanged: (listener) => bridge.on("DB_CHANGED", listener),
      connected: () => bridge.status === "connected",
      seeds: (chatIds) => bridgeChatTitleSeedsByOwner(bridge, chatIds),
      request: requestAiChatTitle,
      dispatch,
    });
  }, [bridge, dispatch]);
  return null;
}

/** Revalidate the synchronous chat boot snapshot against the engine and mirror
 *  later mutations. SQLite is the durable source of truth; the localStorage
 *  copy only paints chrome without a round-trip on cold start. Rows merge by
 *  updatedAt and engine writes wait for the first pull, so a stale boot cache
 *  cannot overwrite newer rows. */
function ChatsPersistence() {
  const cacheGeneration = accountPresentationGeneration();
  const chats = useChats();
  const activeChatId = useActiveChatId();
  const dispatch = useWorkspaceDispatch();
  const bridge = useBridge();
  const engineRevalidated = React.useRef(false);
  const engineChatsRef = React.useRef<Map<string, ChatThread>>(new Map());
  const engineDeletedIdsRef = React.useRef<Set<string>>(new Set());
  const confirmedCloudWorkspacesRef = React.useRef<Set<string>>(new Set());
  const confirmedLocalChatsRef = React.useRef(false);

  /** Write only rows that are genuinely ahead of the last engine snapshot.
   * Optimistically advance the mirror so a React effect caused by the same
   * reconciliation cannot send a duplicate batch back to the engine. */
  const pushRowsToEngine = React.useCallback((candidates: ChatThread[]) => {
    const rows = candidates.filter((chat) =>
      canMirrorChat(chat, confirmedCloudWorkspacesRef.current, confirmedLocalChatsRef.current, canBackgroundSyncCloudWorkspace),
    );
    if (rows.length === 0) return;
    const engineRows = engineChatsRef.current;
    const previous = new Map<string, ChatThread | undefined>();
    for (const row of rows) {
      previous.set(row.id, engineRows.get(row.id));
      engineRows.set(row.id, row);
      engineDeletedIdsRef.current.delete(row.id);
    }
    const identityClears = rows.flatMap((row) => {
      const clear = providerIdentityClearForTransition(
        previous.get(row.id),
        row,
      );
      return clear ? [clear] : [];
    });
    void (async () => {
      // Same-agent NULL upserts ordinarily preserve an engine-learned binding,
      // which protects against stale renderer/remote snapshots. An intentional
      // renderer transition from a known binding to none therefore needs an
      // explicit compare-and-clear first. The resume-id guard makes a delayed
      // reset harmless if the engine has already learned a newer binding.
      const failedIdentityClears =
        await persistChatRowsWithBestEffortIdentityClears(
          rows.map(threadToRow),
          identityClears,
          dbClearChatProviderIdentity,
          dbReplaceAllChats,
        );
      if (failedIdentityClears.length === 0) return;
      console.warn(
        `[Zeros] ${failedIdentityClears.length} provider identity clear${
          failedIdentityClears.length === 1 ? "" : "s"
        } could not be confirmed; chat metadata was still saved.`,
      );
    })().catch((err) => {
      // Roll back only entries that still point at this failed batch. A newer
      // user edit or live snapshot must never be overwritten by the rollback.
      for (const row of rows) {
        if (engineRows.get(row.id) !== row) continue;
        const prior = previous.get(row.id);
        if (prior) engineRows.set(row.id, prior);
        else engineRows.delete(row.id);
      }
      console.warn("[Zeros] engine chat mirror failed:", err);
    });
  }, []);

  // Each backend confirms independently. A Local restart keeps the cloud
  // subscription installed and closes only Local's read-before-write gate.
  useEffect(() => {
    engineRevalidated.current = false;
    engineChatsRef.current = new Map();
    engineDeletedIdsRef.current = new Set();
    confirmedCloudWorkspacesRef.current = new Set();
    confirmedLocalChatsRef.current = false;
    if (!bridge) return;
    return subscribeChatSnapshots({
      bridge,
      onLocalReadinessChange: () => { confirmedLocalChatsRef.current = false; },
      onError: error => console.warn("[Zeros] Chat reconciliation failed:", error),
      onSnapshot: snapshot => {
        if (cacheGeneration !== accountPresentationGeneration()) return;
        const recovered = snapshot.chats.map(rowToThread);
        const before = useWorkspaceStore.getState();
        const reconciled = reconcileChatSnapshot(
          before.chats,
          recovered,
          snapshot.chatDeletions,
          snapshot.confirmedCloudWorkspaces,
          snapshot.confirmedLocalChats,
        );

        // This is now the exact last-confirmed boot snapshot. If it is empty,
        // clear the recovery copy and record the empty tombstone immediately;
        // otherwise a quit inside the generic 5s transient-empty debounce could
        // resurrect an engine-deleted chat on the next first paint.
        persistWorkspaceChatCache(CHATS_STORAGE_KEY, reconciled.chats, cacheGeneration, before.activeChatId);
        persistWorkspaceChatCache(CHATS_BACKUP_KEY, reconciled.chats, cacheGeneration, before.activeChatId);
        setSetting(CHATS_TOMBSTONE_KEY, reconciled.chats.length === 0);

        // Publish the authoritative baseline before dispatching. The chats
        // persistence effect runs after React commits and will therefore see
        // engine-originated rows as already confirmed rather than echoing them.
        engineChatsRef.current = new Map(
          recovered.map((chat) => [chat.id, chat] as const),
        );
        engineDeletedIdsRef.current = new Set(snapshot.chatDeletions);
        confirmedCloudWorkspacesRef.current = new Set(snapshot.confirmedCloudWorkspaces ?? []);
        confirmedLocalChatsRef.current = snapshot.confirmedLocalChats !== false;
        engineRevalidated.current = true;

        if (reconciled.chats !== before.chats ||
            (before.pendingChatHydrationFolder && (isCloudWorkspace(before.pendingChatHydrationFolder) ? snapshot.confirmedCloudWorkspaces?.includes(before.pendingChatHydrationFolder) : snapshot.confirmedLocalChats !== false)) ||
            (before.pendingWorkspaceValidationFolder && snapshot.confirmedCloudWorkspaces?.includes(before.pendingWorkspaceValidationFolder))) {
          const activeStillExists =
            before.activeChatId !== null &&
            reconciled.chats.some((chat) => chat.id === before.activeChatId);
          dispatch({
            type: "HYDRATE_CHATS",
            chats: reconciled.chats,
            confirmedCloudWorkspaces: snapshot.confirmedCloudWorkspaces ?? [],
            confirmedLocalChats: snapshot.confirmedLocalChats,
            activeChatId: activeStillExists
              ? before.activeChatId
              : resolveBootActiveChatId(reconciled.chats, before.activeChatId, {
                  lastWorkspaceFolder: before.lastWorkspaceFolder,
                  activeChatByFolder: before.activeChatByFolder,
                  confirmedCloudWorkspaces: snapshot.confirmedCloudWorkspaces,
                  confirmedLocalChats: snapshot.confirmedLocalChats,
                }),
          });
        }
        pushRowsToEngine(reconciled.rowsToPush);
        // Housekeeping: drop device-local scroll offsets for chats that no
        // longer exist in the authoritative list (deleted; archived rows are
        // still present and keep theirs). Guarded inside pruneScrollPositions
        // against an empty list so a transient hiccup can't wipe the doc.
        pruneScrollPositions(new Set(reconciled.chats.map((chat) => chat.id)));
        // The Local transcript cache follows the same authoritative list once
        // Local has confirmed it: deleted chats (here or on another device)
        // and removed repositories leave no cached transcript behind.
        if (snapshot.confirmedLocalChats !== false) {
          const known = new Set(reconciled.chats.map((chat) => chat.id));
          localTranscriptCache.retain((chatId) => known.has(chatId));
          retainTranscriptSummaries((chatId) => known.has(chatId));
          retainKnownEmptyLocalChats((chatId) => known.has(chatId));
        }
      },
    });
  }, [bridge, dispatch, pushRowsToEngine, cacheGeneration]);

  // Persist on change. The tombstone needs a non-empty → empty transition that
  // lasts 5 s: a transient empty list (workspace swap, reducer race) must not
  // block backup recovery or wipe the sidebar. Backup writes are additive, so
  // they stay immediate.
  const prevChatsLengthRef = useRef<number | null>(null);
  const prevChatIdsRef = useRef<Set<string> | null>(null);
  const tombstoneTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (cacheGeneration !== accountPresentationGeneration()) return;
    persistWorkspaceChatCache(CHATS_STORAGE_KEY, chats, cacheGeneration, activeChatId);
    // The bulk write below is a non-destructive MERGE, so a removed chat must be
    // deleted explicitly or it reappears on reload. Never for an empty list: that
    // is usually transient and must not mass-delete the engine copy.
    const currentIds = new Set(chats.map((c) => c.id));
    if (chats.length > 0 && prevChatIdsRef.current) {
      for (const id of prevChatIdsRef.current) {
        if (currentIds.has(id)) continue;
        // A tombstone-driven reconciliation is already durable. Echoing the
        // delete would mint a new revision and notify every other client again.
        if (!engineDeletedIdsRef.current.has(id)) {
          void dbDeleteChat(id).catch(() => {});
        }
        engineChatsRef.current.delete(id);
      }
    }
    prevChatIdsRef.current = currentIds;
    // Mirror the (remaining) chats to the engine — the durable copy. Fire-and-
    // forget; the LS write above is the renderer's instant ack, the engine catches
    // up next tick. On failure the next mutation retries the full list.
    if (engineRevalidated.current) {
      const rowsToPush = chats.filter((chat) => {
        const engineChat = engineChatsRef.current.get(chat.id);
        if (!engineChat) return true;
        if (chat.updatedAt < engineChat.updatedAt) return false;
        return !samePersistedChat(chat, engineChat);
      });
      pushRowsToEngine(rowsToPush);
    }
    if (chats.length > 0) {
      persistWorkspaceChatCache(CHATS_BACKUP_KEY, chats, cacheGeneration, activeChatId);
      setSetting(CHATS_TOMBSTONE_KEY, false);
      if (tombstoneTimerRef.current !== null) {
        window.clearTimeout(tombstoneTimerRef.current);
        tombstoneTimerRef.current = null;
      }
      prevChatsLengthRef.current = chats.length;
      return;
    }
    // chats.length === 0 below.
    const prev = prevChatsLengthRef.current;
    prevChatsLengthRef.current = 0;
    if (prev === null || prev === 0) {
      // Empty → empty: before hydrate, or a fresh install. Leave the tombstone alone.
      return;
    }
    // Non-empty → empty. Schedule a tombstone write after the debounce.
    // Cancelled in the non-empty branch above if chats reappear.
    if (tombstoneTimerRef.current === null) {
      tombstoneTimerRef.current = window.setTimeout(() => {
        setSetting(CHATS_TOMBSTONE_KEY, true);
        tombstoneTimerRef.current = null;
      }, 5000);
    }
  }, [chats, pushRowsToEngine, cacheGeneration, activeChatId]);

  useEffect(() => {
    // Mirror the active chat's picker state into sticky defaults so the next
    // "+ New Agent" starts the same way. Without an active chat (New Agent was just
    // clicked), the prior sticky defaults stay in charge.
    if (activeChatId) {
      const active = chats.find((c) => c.id === activeChatId);
      if (active) {
        saveStickyDefaults({
          agentId: active.agentId,
          folder: active.folder || null,
          model: active.model,
          effort: active.effort,
          permissionMode: active.permissionMode,
        });
      }
    }
  }, [activeChatId, chats]);

  return null;
}

/** A project-folder change respawns the engine on a new port. Swap in place
 *  without a reload: drop sessions (they reference the dead engine's
 *  executionIds; provider bindings resume later), reconnect the bridge, and
 *  bump projectGeneration so project-scoped consumers rerun. Late callbacks
 *  from the old engine are dropped: its socket is closed and disposeAll()
 *  wiped the executionId map. */
function ReloadOnProjectChange() {
  const sessions = useAgentSessions();
  const bridge = useBridge();
  const dispatch = useWorkspaceDispatch();
  useEffect(
    () => (bridge ? startPersonalPreferencesSync(bridge) : undefined),
    [bridge],
  );
  useEffect(
    () => (bridge ? startAgentPreferencesSync(bridge) : undefined),
    [bridge],
  );

  // Import legacy localStorage settings into the engine's TOML files at app boot,
  // not only when Settings opens. The personal repo file is created only after
  // local exclusion is established. Flag-guarded and merged under existing
  // values engine-side, so every bridge change may call it.
  useEffect(() => {
    void ensureSettingsTomlMigrated(bridge);
    // One-time import of legacy 🔒 env secrets (`env::<NAME>` + the [env]
    // sentinel rows) into the Keychain env vault — without it those variables
    // silently stopped reaching agents when the old courier was removed.
    void ensureEnvSecretsInVault(bridge);
    // Also drop any dead [providers.<retired-agent>] entries left in the file
    // (e.g. factory-droid after it was removed) — ungated + idempotent.
    void pruneRetiredProviders(bridge);
  }, [bridge]);

  // Normalize the pre-redesign default-agent + per-family favorite pair into
  // the one atomic model selection. This is the ONLY writer of that migration:
  // getFavoriteSelection() is read during render by every model surface, so it
  // stays pure and simply recomputes the legacy answer until this lands.
  useEffect(() => {
    migrateDefaultModelSelection();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    // Recents come only from explicit user action. The engine always boots into
    // some cwd (the dev repo or ~/.zeros/default-project), and seeding that would
    // resurrect entries the user cleared.

    onProjectChanged((payload) => {
      console.log("[Zeros] project changed", payload);
      rememberProject(payload.root);
      sessions.disposeAll();
      // Clear only the folder hint: the next "+ New Agent" uses the new engine root,
      // while agent, model, effort and permission carry over.
      saveStickyDefaults({ ...loadStickyDefaults(), folder: null });
      dispatch({ type: "BUMP_PROJECT_GENERATION" });
      // Not awaited: status moves to "connecting" at once and consumers follow
      // useBridgeStatus.
      void bridge?.forceReconnect();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [sessions, bridge, dispatch]);
  return null;
}

const WORKBENCH_COLLAPSED_KEY = "column-3-collapsed"; // gitleaks:allow — localStorage key name

// Main routes are the app sidebar followed by the two-column body (or a Home
// page). Settings replaces the sidebar with its own section nav.
const APP_ROOT_CLS =
  "fixed inset-0 flex flex-col overflow-hidden bg-bg1 font-sans text-sm text-fg1";
const APP_BODY_CLS =
  "flex flex-1 flex-row min-h-0 min-w-0 overflow-hidden bg-bg1";

function ShellRouter() {
  // Courier the team settings layer into the engine (on connect, every
  // 15 min, and on demand after settings/membership changes). Lives here
  // because it needs the bridge (BridgeProvider is inside AppShellBody).
  useTeamEngineSync();
  const active = useActiveWorkspace();
  const workspaceToolsAvailable = !active.loading && !workspaceIsReadOnly(active.workspace);

  // One persisted Workbench collapse for every workspace, changed only by the
  // user's toggle (window chrome or ⌥⌘B).
  const [workbenchColumn, setWorkbenchColumn] = React.useState<WorkbenchColumnState>(
    () => ({
      collapsed: getSetting<boolean>(WORKBENCH_COLLAPSED_KEY, false),
      hiddenByFloat: false,
    }),
  );
  const workbenchCollapsed = workbenchColumn.collapsed;
  const updateWorkbenchColumn = React.useCallback(
    (event: WorkbenchColumnEvent) => {
      if (!workspaceToolsAvailable) return;
      setWorkbenchColumn((previous) => {
        const next = nextWorkbenchColumnState(previous, event);
        if (next === previous) return previous;
        setSetting(WORKBENCH_COLLAPSED_KEY, persistedWorkbenchCollapsed(next));
        return next;
      });
    },
    [workspaceToolsAvailable],
  );
  const toggleWorkbench = React.useCallback(
    () => updateWorkbenchColumn("toggle"),
    [updateWorkbenchColumn],
  );
  const revealWorkbench = React.useCallback(
    () => updateWorkbenchColumn("reveal"),
    [updateWorkbenchColumn],
  );
  // Floating a Browser preview over the chat hides the column it came from;
  // closing the last float brings it back unless the user changed it since.
  React.useEffect(
    () => onWorkbenchCollapseRequest(() => updateWorkbenchColumn("float")),
    [updateWorkbenchColumn],
  );
  React.useEffect(
    () => onWorkbenchRestoreRequest(() => updateWorkbenchColumn("floats-closed")),
    [updateWorkbenchColumn],
  );

  // ⌥⌘B toggles Workbench. Match `e.code`: on macOS, Option remaps `e.key` to a
  // glyph (Option+B → "∫").
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
      if (e.code !== "KeyB") return;
      // Skipped inside editable surfaces — but NOT inside a focused
      // terminal (xterm's hidden textarea would otherwise swallow this
      // global chord). See apps/desktop/src/renderer/shell/editable-target.ts.
      if (isEditableHotkeyTarget(e.target)) return;
      e.preventDefault();
      toggleWorkbench();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleWorkbench]);

  // ⌥⌘T flips the resolved variant, not the stored mode: with the OS in dark
  // mode, "system" and "dark" look identical, so cycling modes could look dead.
  // `e.code` for the same Option reason as ⌥⌘B.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
      if (e.code !== "KeyT") return;
      // Skipped inside editable surfaces, but pass through a focused
      // terminal (see apps/desktop/src/renderer/shell/editable-target.ts).
      if (isEditableHotkeyTarget(e.target)) return;
      e.preventDefault();
      // Flip what's on screen — getVariant() is the store's already-resolved
      // variant (honoring "system").
      setPrefs({ mode: getVariant() === "dark" ? "light" : "dark" });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ⌥⌘F opens the app's single feedback dialog; other surfaces summon it through
  // feedback-controller. It fires inside editable surfaces too: the chord types
  // nothing, and feedback often follows a composer problem.
  const [feedbackOpen, setFeedbackOpen] = React.useState(false);
  React.useEffect(
    () => onFeedbackDialogRequest(() => setFeedbackOpen(true)),
    [],
  );
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
      if (e.code !== "KeyF") return;
      if (!isFeedbackConfigured()) return;
      e.preventDefault();
      setFeedbackOpen(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ⌥⌘/ anywhere toggles the glass shortcuts palette. Unlike the chords above
  // it fires inside editable surfaces too (⌥⌘/ types nothing, and the palette
  // must open from — and close over — a focused composer). See
  // apps/desktop/src/renderer/shell/use-shortcuts-hotkey.ts.
  const [palette, setPalette] = React.useState<"commands" | "shortcuts" | null>(null);
  const toggleShortcuts = React.useCallback(
    () => setPalette((prev) => prev === "shortcuts" ? null : "shortcuts"),
    [],
  );
  useShortcutsHotkey(toggleShortcuts);
  const toggleCommands = React.useCallback(
    () => setPalette((prev) => prev === "commands" ? null : "commands"),
    [],
  );
  useCommandPaletteHotkey(toggleCommands);

  // ⇧⌘L copies recent app logs — an INTERNAL feature; the listener only
  // attaches for allowlisted accounts with the flag on (Settings →
  // Internal). Deliberately absent from the ⌥⌘/ catalog. See
  // apps/desktop/src/renderer/shell/use-copy-logs-hotkey.ts.
  useCopyLogsHotkey();

  // Every route flows through MainShellBody so the app sidebar is the one
  // constant across the workspace view and the Home sub-pages (Dashboard /
  // Customize / repository pages / Create). Settings takes the sidebar's place
  // with its own section nav and a Back row.
  return (
    <div className={APP_ROOT_CLS}>
      <BrowserSessionController
        onRevealBrowser={revealWorkbench}
        workbenchCollapsed={workbenchCollapsed}
      />
      <SimulatorAgentController onRevealWorkbench={revealWorkbench} />
      <BrowserAgentPictureInPicture
        visible={workspaceToolsAvailable && workbenchCollapsed}
        onRestore={revealWorkbench}
      />
      {/* AddProjectProvider wraps the shell so File → Open Folder and its
          dialogs stay available from every Home sub-page as well as the
          workspace view. */}
      <AddProjectProvider>
        <MainShellBody
          workbenchCollapsed={workbenchCollapsed}
          toggleWorkbench={toggleWorkbench}
          revealWorkbench={revealWorkbench}
        />
        {palette === "commands" && <CommandPaletteController
          onDismiss={() => setPalette(current => current === "commands" ? null : current)}
          onShowShortcuts={() => setPalette("shortcuts")}
          revealWorkbench={revealWorkbench}
          toggleWorkbench={toggleWorkbench}
        />}
      </AddProjectProvider>
      <ShortcutsPalette open={palette === "shortcuts"} onOpenChange={open => setPalette(current => open ? "shortcuts" : current === "shortcuts" ? null : current)} />
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </div>
  );
}

// History retains chats while keeping workspace tools and agent admission unmounted.
function MainShellBody({
  workbenchCollapsed,
  toggleWorkbench,
  revealWorkbench,
}: {
  workbenchCollapsed: boolean;
  toggleWorkbench: () => void;
  revealWorkbench: () => void;
}) {
  // One renderer-wide observer catches agent completions even while Workbench
  // is collapsed, Home is visible, or read-only history replaces the
  // workspace shell. Consumers remain ordinary key subscriptions.
  useGitRefreshCoordinator();
  useProjectCapabilitiesRefresh();
  const activePage = useActivePage();
  const activeRepoId = useActiveRepoId();
  const createWorkspaceProjectId = useCreateWorkspaceProjectId();
  const { openProject, openGithubProject, quickStart } = useAddProject();
  const {
    workspace: activeWorkspace,
    folder: activeWorkspaceFolder,
    project: activeProject,
    loading: workspaceLoading,
  } = useActiveWorkspace();
  const historyOnly = workspaceIsReadOnly(activeWorkspace);
  const workspaceToolsAvailable = !workspaceLoading && !historyOnly;
  useOpenBrowserHotkey(
    activePage === "workspace" &&
      Boolean(activeWorkspaceFolder) &&
      workspaceToolsAvailable,
    revealWorkbench,
  );
  const shellSurfaceRef = useRef<HTMLDivElement | null>(null);
  useInstantViewSwitch(
    `${activePage}:${activeWorkspace?.id ?? activeRepoId ?? activeProject?.id ?? "none"}`,
    shellSurfaceRef,
  );
  // Reveal a PR opened outside the engine (agent `gh pr create` / terminal): if
  // the active workspace has no recorded prNumber, detect + backfill it so the
  // Workbench PR-status island appears and the header "Create PR" button hides.
  useWorkspacePrSync(workspaceToolsAvailable ? activeWorkspace : null);
  const { projects } = useProjects();
  useWarmAutomaticRepositoryIcons(projects);
  // ⌘T opens a chat; ⌘⇧T opens a terminal-agent tab when that feature is
  // enabled. Mounted here so neither shortcut fires from Settings.
  useNewTabHotkeys(activePage === "workspace" && workspaceToolsAvailable);
  // Zero projects -> full-window welcome (logo + Open project / GitHub /
  // Quick start tiles) instead of the empty three-column shell.
  const showWelcome = projects.length === 0;
  // The Home sub-pages share one shell beside the app sidebar. "repo" is the
  // per-repo page (workspaces + settings) reached from a repository's settings
  // action; "customize" is agent capabilities (MCP now) scoped User / per-repo.
  const isHome =
    activePage === "create" ||
    activePage === "dashboard" ||
    activePage === "customize" ||
    activePage === "settings" ||
    activePage === "repo";
  // The repo page's target, validated against the live project list — a
  // removed/stale id falls through to the Dashboard instead of a dead page.
  const activeRepoProject =
    activePage === "repo" && activeRepoId
      ? (projects.find((p) => p.id === activeRepoId) ?? null)
      : null;
  const activeHomePageId = isHome
    ? activePage === "create"
      ? "create"
      : activePage === "settings"
        ? "settings"
        : activePage === "customize"
          ? "customize"
          : activeRepoProject
            ? "repo"
            : "dashboard"
    : null;
  // Five bounded Home wrappers retain navigation layout. Create's portal-heavy
  // composer mounts only while active below, so hidden menus/editors cannot
  // keep effects, focus, or overlays alive behind another surface.
  const homePageIdsToRender = useRetainedViewKeys(activeHomePageId, 5);
  // Keeps RepoPage's bounded per-repository deck alive while Dashboard or
  // Settings is visible; updated only by a valid repo route.
  const retainedRepoProjectRef = React.useRef(activeRepoProject);
  React.useLayoutEffect(() => {
    if (activeRepoProject) retainedRepoProjectRef.current = activeRepoProject;
  }, [activeRepoProject]);
  const retainedRepoProject = retainedRepoProjectRef.current;
  const repoProjectForDeck =
    activeRepoProject ??
    (retainedRepoProject &&
    projects.some((project) => project.id === retainedRepoProject.id)
      ? retainedRepoProject
      : null);
  // Avoid starting workspace-only keepers/PTY views for a session that opens
  // directly on Home; after the first workspace visit the shell stays alive.
  const workspaceShellRetainedRef = React.useRef(activePage === "workspace");
  React.useLayoutEffect(() => {
    if (activePage === "workspace") workspaceShellRetainedRef.current = true;
  }, [activePage]);
  const renderWorkspaceShell =
    !workspaceLoading &&
    !showWelcome &&
    (workspaceShellRetainedRef.current || activePage === "workspace");
  // Collapsing the sidebar leaves the traffic lights and its panel-left toggle
  // floating over the content's top-left corner; the surface that owns that
  // corner keeps it clear. Settings always replaces the sidebar with its own
  // section nav and title band, so neither applies there.
  const sidebarCollapsed = useSidebarCollapsed();
  const settingsActive = activeHomePageId === "settings";
  const collapsedControlsVisible = sidebarCollapsed && !settingsActive;

  return (
    <div
      ref={shellSurfaceRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-row"
    >
      {/* Always mounted: the sidebar also owns app-wide navigation keepers
          (project sync, run activity, workspace validation). Collapsing it or
          opening Settings (which shows its own section nav in its place) only
          hides it. */}
      <AppSidebar hidden={settingsActive || sidebarCollapsed} />
      <div className={APP_BODY_CLS}>
        <div className="text-fg1 bg-bg1 relative flex min-h-0 min-w-0 flex-1 overflow-hidden font-sans text-sm antialiased">
          {activePage === "workspace" && workspaceLoading && (
            <div className="flex-1" aria-label="Loading workspace" aria-busy="true" />
          )}
          {/* Every workspace uses the same conversation tree. Read-only
              history keeps its tabs/transcript and unmounts workspace tools. */}
          {renderWorkspaceShell && (
            <div
              {...(isHome ? { inert: "" } : {})}
              className={[
                "absolute inset-0 flex min-h-0 min-w-0 overflow-hidden",
                isHome
                  ? "pointer-events-none invisible"
                  : "pointer-events-auto visible",
              ].join(" ")}
              aria-hidden={isHome}
            >
              <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <div className="absolute inset-0 flex min-h-0 min-w-0 overflow-hidden">
                  <ConversationPane
                    workbenchCollapsed={workbenchCollapsed}
                    onToggleWorkbench={toggleWorkbench}
                    workspace={activeWorkspace}
                    windowControlsInset={sidebarCollapsed}
                  />
                  {workspaceToolsAvailable && <WorkbenchPane
                    onToggleWorkbench={toggleWorkbench}
                    surfaceActive={!isHome && !workbenchCollapsed}
                    collapsed={workbenchCollapsed}
                  />}
                </div>
              </div>
            </div>
          )}
          {showWelcome && !isHome && (
            <div className="absolute inset-0 flex min-h-0 min-w-0">
              <NoProjectsView />
            </div>
          )}

          {homePageIdsToRender.length > 0 && (
            <div
              {...(!isHome ? { inert: "" } : {})}
              className={[
                "absolute inset-0 flex min-h-0 min-w-0 overflow-hidden",
                isHome
                  ? "pointer-events-auto visible"
                  : "pointer-events-none invisible",
              ].join(" ")}
              aria-hidden={!isHome}
            >
              {/* Dropdowns opened inside this column stay inside it (popover-boundary.ts). */}
              <div
                {...popoverBoundaryProps}
                className={[
                  "relative flex min-h-0 min-w-0 flex-1 overflow-hidden",
                  // Home pages start below the collapsed window controls.
                  collapsedControlsVisible ? "mt-10" : "",
                ].join(" ")}
              >
                {homePageIdsToRender.includes("dashboard") && (
                  <div
                    {...(activeHomePageId !== "dashboard" ? { inert: "" } : {})}
                    className={[
                      "absolute inset-0 flex min-h-0 min-w-0",
                      activeHomePageId === "dashboard"
                        ? "pointer-events-auto visible"
                        : "pointer-events-none invisible",
                    ].join(" ")}
                    aria-hidden={activeHomePageId !== "dashboard"}
                  >
                    {showWelcome ? <NoProjectsView /> : <DashboardPage />}
                  </div>
                )}
                {homePageIdsToRender.includes("customize") && (
                  <div
                    {...(activeHomePageId !== "customize" ? { inert: "" } : {})}
                    className={[
                      "absolute inset-0 flex min-h-0 min-w-0",
                      activeHomePageId === "customize"
                        ? "pointer-events-auto visible"
                        : "pointer-events-none invisible",
                    ].join(" ")}
                    aria-hidden={activeHomePageId !== "customize"}
                  >
                    <CustomizePage
                      surfaceActive={activeHomePageId === "customize"}
                    />
                  </div>
                )}
                {homePageIdsToRender.includes("settings") && (
                  <div
                    {...(activeHomePageId !== "settings" ? { inert: "" } : {})}
                    data-zeros-root=""
                    className={[
                      "zeros-settings-root absolute inset-0 flex min-h-0 min-w-0",
                      activeHomePageId === "settings"
                        ? "pointer-events-auto visible"
                        : "pointer-events-none invisible",
                    ].join(" ")}
                    aria-hidden={activeHomePageId !== "settings"}
                  >
                    <SettingsPage />
                  </div>
                )}
                {homePageIdsToRender.includes("repo") && repoProjectForDeck && (
                  <div
                    {...(activeHomePageId !== "repo" ? { inert: "" } : {})}
                    className={[
                      "absolute inset-0 flex min-h-0 min-w-0",
                      activeHomePageId === "repo"
                        ? "pointer-events-auto visible"
                        : "pointer-events-none invisible",
                    ].join(" ")}
                    aria-hidden={activeHomePageId !== "repo"}
                  >
                    <RepoPage project={repoProjectForDeck} />
                  </div>
                )}
                {homePageIdsToRender.includes("create") && (
                  <div
                    {...(activeHomePageId !== "create" ? { inert: "" } : {})}
                    className={[
                      "absolute inset-0 flex min-h-0 min-w-0",
                      activeHomePageId === "create"
                        ? "pointer-events-auto visible"
                        : "pointer-events-none invisible",
                    ].join(" ")}
                    aria-hidden={activeHomePageId !== "create"}
                  >
                    {activeHomePageId === "create" && (
                      <DispatcherPage
                        active
                        initialProjectId={createWorkspaceProjectId}
                        onOpenProject={openProject}
                        onOpenGithubProject={openGithubProject}
                        onQuickStart={quickStart}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {collapsedControlsVisible && <CollapsedSidebarControls />}
    </div>
  );
}

/** Everything below the auth/appearance gate: the native bridge and the app.
 *  <AppShell> owns the providers and AuthGate above this boundary. */
export function AppShellBody() {
  useEditHistoryMenu();
  return (
    // App-wide: every shell surface, including Settings, uses Tooltip.
    <TooltipProvider>
      <BridgeProvider>
        <AgentSessionsProvider>
          <HydrateAiApiKey />
          <AnalyticsBoot />
          <PreWarmAgents />
          <ReloadOnProjectChange />
          <ChatsPersistence />
          <LocalLinkNavigation readChat={rowToThread} />
          <CloudWorkspaceLifecycle />
          <ChatUnreadTracking />
          <ChatTitleBackfill />
          <BrowserConfirmationController />
          <AgentControlConfirmationController />
          <ComputerUseController />
          <SimulatorController />
          <ShellRouter />
        </AgentSessionsProvider>
      </BridgeProvider>
    </TooltipProvider>
  );
}

/** Above the AuthGate so a zeros://invite deep link is captured even when
 *  signed out or cold-launching, and the pending token is dropped on sign-out
 *  so it cannot bleed into the next account. Navigation
 *  to Settings is set via the store + persisted section key; harmless while
 *  signed out, and the post-sign-in mount opens the invite over General. */
function InviteDeepLinkHandler() {
  const dispatch = useWorkspaceDispatch();
  const { status, userId } = useAuth();
  const openTeamForInvite = React.useCallback(() => {
    setSetting("settings:active-section", "user:general");
    dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
  }, [dispatch]);
  useInviteDeepLink(openTeamForInvite);
  const prevUserId = React.useRef(userId);
  React.useEffect(() => {
    const signedOut = prevUserId.current !== null && userId === null && status === "unauthenticated";
    const accountChanged =
      prevUserId.current !== null &&
      userId !== null &&
      prevUserId.current !== userId;
    if (signedOut || accountChanged) {
      clearPendingInviteToken();
      // Account presentation retires before AuthProvider publishes identity.
    }
    prevUserId.current = userId;
  }, [status, userId]);
  return null;
}

/** WorkOS/organization events invalidate the shared exact `/v1/me` snapshot;
 * the store retains its last confirmed value while the refresh is in flight. */
function AuthSecurityEventHandler() {
  const { status } = useAuth();
  React.useEffect(() => {
    if (status !== "authenticated") return;
    let active = true;
    let off: (() => void) | undefined;
    void nativeListen("auth-security-event", () => {
      if (!active) return;
      void refreshTeams().finally(() => requestTeamResync());
    }).then((unsubscribe) => {
      if (active) off = unsubscribe;
      else unsubscribe();
    });
    return () => {
      active = false;
      off?.();
    };
  }, [status]);
  return null;
}

export function AppShell() {
  return (
    <AppearanceProvider>
      <AuthProvider onStoredIdentity={installAccountPresentationIdentity}>
        {/* The single app-wide toast surface: never add inline pills or banners for
            transient feedback (docs/design-system.md, Feedback). Above the AuthGate
            so toasts, including auto-update, render on the login screen. */}
        <Toaster />
        <GithubAppNotifications />
        {/* Above the gate so a main-process-staged update can notify on the
            login screen too. Main owns checking/downloading even with no
            renderer; useAnyAgentRunning reads a global Zustand store, so no
            provider below the gate is required. */}
        <UpdateNotifications />
        <KeepAwakeController />
        <InviteDeepLinkHandler />
        <AuthSecurityEventHandler />
        <AuthGate>
          <AppShellBody />
        </AuthGate>
      </AuthProvider>
    </AppearanceProvider>
  );
}

export default AppShell;
