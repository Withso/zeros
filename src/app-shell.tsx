// ──────────────────────────────────────────────────────────
// Zeros Mac App — Global Top Bar + Two-Column Workspace Shell
// ──────────────────────────────────────────────────────────
//
// Layout: global repository/workspace navigation sits above the agent chat and
// right-side work surface:
//
//   ┌─────────────────────────────────────────────────────┐
//   │ Home · Create │ Repository │ main · workspaces · + │
//   ├─────────────────────────┬───────────────────────────┤
//   │ Agent Workspace         │ Browser / panels          │
//   │ chat                    │ tabs + workspace          │
//   └─────────────────────────┴───────────────────────────┘
//
// Column 3 mounts the design workspace beside native-adjacent tools
// such as Git, Terminal, Env, and Todo.
// ──────────────────────────────────────────────────────────

import React, { useEffect, useRef } from "react";
import {
  useChats,
  useActiveChatId,
  useActivePage,
  useActiveRepoId,
  useWorkspaceDispatch,
  useWorkspaceStore,
  normalizeChatPermissionMode,
  type ChatThread,
} from "./zeros/store/store";
import { resolveBootActiveChatId } from "./zeros/store/boot-active-chat";
import { sanitizeChatDirectories } from "./zeros/store/chat-boot-cache";
import {
  reconcileChatSnapshot,
  samePersistedChat,
} from "./zeros/store/chat-reconciliation";
import { hydrateAiApiKey } from "./zeros/lib/openai";
import {
  BridgeProvider,
  useBridge,
  useExtensionConnected,
} from "./zeros/bridge/use-bridge";
import {
  ensureEnvSecretsInVault,
  ensureSettingsTomlMigrated,
  pruneRetiredProviders,
} from "./zeros/settings/migrate-legacy";
import { AgentSessionsProvider } from "./zeros/agent/sessions-provider";
import { useAgentSessions } from "./zeros/agent/sessions-hooks";
import { useDesignLintCoordinator } from "./zeros/agent/use-design-lint-coordinator";
import { UpdateNotifications } from "./zeros/update/update-notifications";
import { useCopyLogsHotkey } from "./shell/use-copy-logs-hotkey";
import { useNewTabHotkeys } from "./shell/use-new-chat-hotkey";
import { useShortcutsHotkey } from "./shell/use-shortcuts-hotkey";
import { ShortcutsPalette } from "./shell/shortcuts-palette";
import { FeedbackDialog } from "./shell/dialogs/feedback-dialog";
import { onFeedbackDialogRequest } from "./shell/feedback-controller";
import { isFeedbackConfigured } from "./zeros/feedback/submit-feedback";
import { ModelsSettingsSync } from "./zeros/agent/models-settings-sync";
import { TopBar } from "./shell/top-bar";
import { Column2Workspace } from "./shell/column2-workspace";
import { Column3 } from "./shell/column3";
import { DesignWorkspaceColumn } from "./zeros/panels/design-workspace";
import { useWorkspacePrSync } from "./shell/pr/use-workspace-pr-sync";
import { WorktreeMissingPanel } from "./shell/worktree-missing-panel";
import { AddProjectProvider } from "./shell/add-project-provider";
import { NoProjectsView } from "./shell/no-projects-view";
import { HomeSidebar } from "./shell/home-sidebar";
import { useActiveWorkspace } from "./zeros/store/use-active-workspace";
import { usePendingWorkspaceKind } from "./zeros/store/pending-workspaces";
import { resolveWorkspacePresentationKind } from "./zeros/store/workspace-resolution";
import {
  notifyWorkspacesChanged,
  useProjects,
} from "./zeros/store/use-projects";
import { deleteWorkspacePermanently } from "./zeros/store/archive-actions";
import { SettingsPage } from "./zeros/panels/settings-page";
import { DashboardPage } from "./zeros/panels/dashboard-page";
import { CustomizePage } from "./zeros/panels/customize-page";
import { RepoPage } from "./zeros/panels/repo-page";
import { onProjectChanged } from "./native/native";
import {
  loadStickyDefaults,
  saveStickyDefaults,
} from "./shell/sticky-defaults";
import { isEditableHotkeyTarget } from "./shell/editable-target";
import { getSetting, setSetting } from "./native/settings";
import {
  useInviteDeepLink,
  clearPendingInviteToken,
} from "./zeros/team/invite-link";
import { useTeamEngineSync } from "./zeros/team/team-sync";
import { clearTeamStore } from "./zeros/team/team-store";
import { useAuth } from "./zeros/auth";
import { rememberProject } from "./native/recent-projects";
import {
  dbChatSnapshot,
  dbReplaceAllChats,
  dbDeleteChat,
  type ChatRowWire,
} from "./zeros/agent/agent-history-client";
import {
  loadScrollPositions,
  pruneScrollPositions,
} from "./zeros/agent/device-local";
import { useSessionsStore } from "./zeros/agent/sessions-store";
import { AnalyticsBoot } from "./zeros/analytics/boot";
import { AppearanceProvider } from "./zeros/appearance/provider";
import { getVariant, setPrefs } from "./zeros/appearance/store";
import { AuthProvider, AuthGate } from "./zeros/auth";
import { Toaster, toast } from "./zeros/ui/primitives/elements";
import { TooltipProvider } from "./zeros/ui/primitives/tooltip";
import { useInstantViewSwitch } from "./zeros/ui/use-instant-view-switch";
import { useRetainedViewKeys } from "./shell/use-retained-view-keys";
import { useGitRefreshCoordinator } from "./shell/use-git-refresh-key";
import { GithubAppNotifications } from "./zeros/bridge/github-app-notifications";

// Chat localStorage cache keys live in a shared module so the repo-removal
// path (which bulk-deletes a repo's chats) reconciles the exact same keys this
// component's ChatsPersistence owns — a drifted key would resurrect deleted
// chats on reload. See chats-local-cache.ts for the full rationale per key.
import {
  CHATS_BACKUP_KEY,
  CHATS_STORAGE_KEY,
  CHATS_TOMBSTONE_KEY,
} from "./zeros/store/chats-local-cache";

/** Module-level prewarm sentinel.
 *
 *  Why module-scope (not useRef): Vite Fast Refresh remounts the
 *  PreWarmAgents component on every renderer-side HMR. A React ref
 *  resets to its initial value on each remount, so the prewarm effect
 *  re-fired the AGENT_INIT_AGENT calls for all enabled agents every
 *  time the user saved a file. The engine's event loop got overwhelmed processing the
 *  avalanche, the sidecar watchdog failed its TCP probes, and the
 *  engine was force-respawned mid-session — the exact pattern the
 *  user pasted in their log.
 *
 *  This sentinel lives outside the component, so it survives HMR.
 *  Reset only when `engineReady` drops to false (engine actually died
 *  / restarted) — then the next ENGINE_READY rearms a fresh prewarm. */
let prewarmedForEngineSession = false;

// Device-local scroll positions must exist before the first chat layout effect;
// a passive ChatsPersistence effect is already too late and causes a visible
// snap-to-bottom followed by restoration. This cache read is synchronous,
// validated by the sessions store, and does no bridge/native work.
try {
  useSessionsStore.getState().seedScrollPositions(loadScrollPositions());
} catch (err) {
  console.warn("[Zeros] scroll-position boot hydration failed:", err);
}

/**
 * Pre-warm agent subprocesses so the first real session isn't paying
 * cold-start cost (CLI discovery + adapter spawn + agent initialize
 * handshake). Runs once per engine session and warms, in priority order:
 *
 *   1. the active chat's agent (user is about to talk to it)
 *   2. the rest of the agents currently attached to any chat
 *   3. every enabled registry agent (first-run: all of them)
 *
 * Everything is fire-and-forget. Already-warm agents (tracked in the
 * sessions store's `warmAgentIds`) are skipped so the focus-driven
 * rewarm doesn't hammer initAgent when nothing needs warming.
 */
function PreWarmAgents() {
  const chats = useChats();
  const activeChatId = useActiveChatId();
  const sessions = useAgentSessions();
  const engineReady = useExtensionConnected();

  const warmAll = React.useCallback(async () => {
    try {
      const registry = await sessions.listAgents();
      const persisted = readEnabledAgentIds();
      // Mirror useEnabledAgents.isEnabled — first-run defaults exclude
      // beta agents so the warmup loop doesn't fire AGENT_INIT_AGENT
      // for an agent we hide from the picker.
      const isEnabled = (id: string, isBeta?: boolean) =>
        persisted === null ? !isBeta : persisted.includes(id);

      // Build the set of currently-known agent IDs ONCE so the filter
      // below is O(1). Chat rows persist across registry changes —
      // user might have an old chat whose `agentId` was removed (e.g.
      // copilot, deprecated by the V1 plan) or that lives only in the
      // terminal panel registry (e.g. amp). Without this guard, every
      // app launch fired AGENT_INIT_AGENT for those phantom IDs and
      // silently caught the engine's "unknown agent" reply — quiet but
      // wasteful, and confused future audits.
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
        if (isEnabled(a.id, a.beta) && !order.includes(a.id)) order.push(a.id);
      }

      // Skip agents the engine already confirmed alive — `warmAgentIds`
      // is cleared on disposeAll (which fires on engine restart), so a
      // genuine re-warm only retries agents that actually need it.
      // Without this, the focus-rewarm + any other trigger would
      // re-fire AGENT_INIT_AGENT × 3 on every focus event.
      const warm = useSessionsStore.getState().warmAgentIds;
      const needsWarm = order.filter((id) => !warm.has(id));
      if (needsWarm.length === 0) return;

      await Promise.all(
        needsWarm.map((id) =>
          sessions.initAgent(id).catch((err) => {
            // Log at debug so a genuine init bug isn't invisible. Don't
            // re-throw — pre-warm is best-effort by design and the next
            // user prompt will surface a real failure via ensureSession.
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

  // Engine-session-scoped prewarm. Two transitions are relevant:
  //   • engineReady false → true: this is a fresh engine session.
  //     If the sentinel is still set from a previous mount, it's
  //     because the engine hasn't died — skip. Otherwise, arm + warm.
  //   • engineReady true → false: engine died (watchdog respawn).
  //     Clear the sentinel so the next ENGINE_READY arms a re-warm.
  useEffect(() => {
    if (!engineReady) {
      prewarmedForEngineSession = false;
      return;
    }
    if (prewarmedForEngineSession) return;
    prewarmedForEngineSession = true;
    void warmAll();
  }, [engineReady, warmAll]);

  // Re-warm on window focus. If the user was backgrounded long enough
  // for the sidecar watchdog to cycle the engine (or for an agent to
  // self-exit on idle), this makes everything hot again before they
  // click anything. Throttled so rapid focus/blur doesn't hammer; the
  // warmAgentIds skip inside warmAll() ensures it's a no-op when
  // everything is already warm.
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

/** Read the persisted enabled-agents list synchronously so PreWarmAgents
 *  can decide which agents are visible without mounting the hook. Returns
 *  null on first run; callers (and useEnabledAgents) treat null as
 *  "enable all non-beta agents" — beta agents stay off until the user
 *  flips them in Settings. */
function readEnabledAgentIds(): string[] | null {
  try {
    const raw = localStorage.getItem("zeros.agent.enabledAgents");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ids?: unknown };
    if (Array.isArray(parsed?.ids)) {
      return parsed.ids.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* corrupt localStorage — fall through to default-on */
  }
  return null;
}

/**
 * Phase 2-C: pull the OpenAI api key from the macOS keychain and merge
 * it into AiSettings. The initial store value is synchronous and comes
 * from localStorage without the secret; this effect fills it in a tick
 * later. Any save from the Settings page persists the key back to the
 * keychain, so subsequent reloads find it here.
 */
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

/** Translate a renderer-side ChatThread to the SQLite wire shape. The
 *  wire form keeps every field a plain JSON-safe value so the IPC
 *  envelope doesn't need a custom serializer. */
function threadToRow(c: ChatThread): ChatRowWire {
  return {
    id: c.id,
    mode: c.mode === "design" ? "design" : "code",
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
  // `kind` is a closed enum on the renderer ("chat" | "terminal" |
  // undefined). The wire form widens to nullable string so legacy rows
  // round-trip; restrict back here so anything stale lands as undefined
  // (== "chat" by store convention).
  const resolvedKind: "chat" | "terminal" | undefined =
    r.kind === "terminal" || r.kind === "chat" ? r.kind : undefined;
  return {
    id: r.id,
    mode: r.mode === "design" ? "design" : "code",
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
    pinned: r.pinned,
    archived: r.archived,
    sourceChatId: r.sourceChatId ?? undefined,
    kind: resolvedKind,
  };
}

/**
 * Revalidate the synchronous chat boot snapshot against the engine and mirror
 * later mutations. The local snapshot is loaded while the Zustand module is
 * initialized, before React's first render; this component never performs a
 * post-paint "hydrate" repair that would flash the wrong workspace/chat.
 *
 * Storage layering (post-migration):
 *   - SQLite (`chats` table) is the durable source of truth. Survives
 *     a localStorage wipe, no 5–10 MB origin quota.
 *   - localStorage (`zeros-chats-v1` + backup + tombstone) is a sync-boot
 *     cache so chat/workspace chrome paints without a round-trip on cold start.
 *
 * SQLite remains authoritative and revalidates in the background. Incoming
 * rows merge by updatedAt so a late fetch cannot overwrite a newer local edit
 * or teleport the active selection. Engine writes are gated until that first
 * pull settles, preventing a stale boot cache from overwriting newer rows.
 */
function ChatsPersistence() {
  const chats = useChats();
  const activeChatId = useActiveChatId();
  const dispatch = useWorkspaceDispatch();
  const bridge = useBridge();
  const engineReady = useExtensionConnected();
  const engineRevalidated = React.useRef(false);
  const engineChatsRef = React.useRef<Map<string, ChatThread>>(new Map());
  const engineDeletedIdsRef = React.useRef<Set<string>>(new Set());

  /** Write only rows that are genuinely ahead of the last engine snapshot.
   * Optimistically advance the mirror so a React effect caused by the same
   * reconciliation cannot send a duplicate batch back to the engine. */
  const pushRowsToEngine = React.useCallback((rows: ChatThread[]) => {
    if (rows.length === 0) return;
    const engineRows = engineChatsRef.current;
    const previous = new Map<string, ChatThread | undefined>();
    for (const row of rows) {
      previous.set(row.id, engineRows.get(row.id));
      engineRows.set(row.id, row);
      engineDeletedIdsRef.current.delete(row.id);
    }
    void dbReplaceAllChats(rows.map(threadToRow)).catch((err) => {
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

  // Pull only after the exact engine connection is live. A monotonic request
  // id prevents an older DB_CHANGED response from landing after a newer one.
  useEffect(() => {
    // Every engine session gets its own read-before-write gate. Otherwise a
    // reconnect could push the renderer's prior snapshot into a newer engine
    // before learning what changed while the socket was down.
    engineRevalidated.current = false;
    engineChatsRef.current = new Map();
    engineDeletedIdsRef.current = new Set();
    if (!bridge || !engineReady) return;
    let cancelled = false;
    let pullId = 0;
    let retryTimer: number | null = null;

    const reconcile = async () => {
      const id = ++pullId;
      try {
        const snapshot = await dbChatSnapshot();
        if (cancelled || id !== pullId) return;
        const recovered = snapshot.chats.map(rowToThread);
        const before = useWorkspaceStore.getState();
        const reconciled = reconcileChatSnapshot(
          before.chats,
          recovered,
          snapshot.chatDeletions,
        );

        // This is now the exact last-confirmed boot snapshot. If it is empty,
        // clear the recovery copy and record the empty tombstone immediately;
        // otherwise a quit inside the generic 5s transient-empty debounce could
        // resurrect an engine-deleted chat on the next first paint.
        setSetting(CHATS_STORAGE_KEY, reconciled.chats);
        setSetting(CHATS_BACKUP_KEY, reconciled.chats);
        setSetting(CHATS_TOMBSTONE_KEY, reconciled.chats.length === 0);

        // Publish the authoritative baseline before dispatching. The chats
        // persistence effect runs after React commits and will therefore see
        // engine-originated rows as already confirmed rather than echoing them.
        engineChatsRef.current = new Map(
          recovered.map((chat) => [chat.id, chat] as const),
        );
        engineDeletedIdsRef.current = new Set(snapshot.chatDeletions);
        engineRevalidated.current = true;

        if (reconciled.chats !== before.chats) {
          const activeStillExists =
            before.activeChatId !== null &&
            reconciled.chats.some((chat) => chat.id === before.activeChatId);
          dispatch({
            type: "HYDRATE_CHATS",
            chats: reconciled.chats,
            activeChatId: activeStillExists
              ? before.activeChatId
              : resolveBootActiveChatId(reconciled.chats, before.activeChatId, {
                  lastWorkspaceFolder: before.lastWorkspaceFolder,
                  activeChatByFolder: before.activeChatByFolder,
                }),
          });
        }
        pushRowsToEngine(reconciled.rowsToPush);
        // Housekeeping: drop device-local scroll offsets for chats that no
        // longer exist in the authoritative list (deleted; archived rows are
        // still present and keep theirs). Guarded inside pruneScrollPositions
        // against an empty list so a transient hiccup can't wipe the doc.
        pruneScrollPositions(new Set(reconciled.chats.map((chat) => chat.id)));
      } catch (err) {
        if (cancelled || id !== pullId) return;
        console.warn("[Zeros] SQLite chat reconciliation failed:", err);
        retryTimer = window.setTimeout(() => void reconcile(), 2_000);
      }
    };

    const offChanged = bridge.on("DB_CHANGED", (raw) => {
      const kinds = Array.isArray((raw as { kinds?: unknown }).kinds)
        ? ((raw as { kinds: string[] }).kinds ?? [])
        : [];
      if (kinds.includes("chats")) void reconcile();
    });
    void reconcile();
    return () => {
      cancelled = true;
      pullId += 1;
      offChanged();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [bridge, dispatch, engineReady, pushRowsToEngine]);

  // (Phase 2c) The renderer one-shot import of pre-2b transcripts was removed:
  // the engine now migrates the legacy zeros-agent-history.db itself, on startup,
  // reading the file directly (src/engine/db/legacy-import.ts) — guaranteed and
  // independent of the renderer.

  // Persist on change (after hydration).
  //
  // Tombstone discipline: the previous version set the tombstone the
  // moment chats was empty for any reason — a single transient
  // empty during workspace swap or a reducer hiccup blocked backup
  // recovery on next mount and visibly wiped the sidebar. Two guards
  // now prevent that:
  //
  //   1. We require a non-empty → empty *transition*. Empty→empty is a
  //      no-op so genuinely fresh installs don't keep rewriting the
  //      tombstone (and don't accidentally set it if the initial reducer
  //      state slips out before hydrate).
  //   2. After the transition, we wait 5 seconds before writing the
  //      tombstone. If chats become non-empty again in that window
  //      (transient hiccup), the timer is cancelled. Only intentional
  //      "user cleared everything and walked away" sticks.
  //
  // Backup updates remain immediate — they're additive and never
  // destructive, so writing them on every non-empty render is fine.
  const prevChatsLengthRef = useRef<number | null>(null);
  const prevChatIdsRef = useRef<Set<string> | null>(null);
  const tombstoneTimerRef = useRef<number | null>(null);
  useEffect(() => {
    setSetting(CHATS_STORAGE_KEY, chats);
    // Propagate DELETIONS to the engine. The bulk write below is a non-destructive
    // MERGE (so one device can't wipe another's chats), so a removed chat must be
    // deleted explicitly or it lingers in the engine and reappears on reload.
    // Guarded to a NON-EMPTY list: an empty `chats` is frequently a transient
    // hiccup (workspace swap, reducer race) — see the tombstone discipline above —
    // and must never mass-delete the durable engine copy.
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
      setSetting(CHATS_BACKUP_KEY, chats);
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
      // Empty → empty. Either initial render before hydrate, or a real
      // fresh install. Don't touch the tombstone — leaving it false
      // means a future write that genuinely transitions non-empty →
      // empty will set it correctly, and a future hydrate sees backup
      // recovery available.
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
  }, [chats, pushRowsToEngine]);

  useEffect(() => {
    // Mirror the active chat's picker state into the sticky-defaults
    // store so the next "+ New Agent" lands with the same agent /
    // folder / model / effort / permission mode the user is currently
    // working in. Skipped when activeChatId is null (e.g. user just
    // clicked New Agent itself) — we want the prior sticky to drive
    // that empty state, not the absence of a chat.
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

/**
 * When the user picks a new project folder, the Electron main process
 * respawns the local engine on a fresh port and emits `project-changed`.
 *
 * In-place swap (no webview reload):
 *   1. Drop every in-memory session — they reference the dead engine's
 *      sessionIds. The persistent chat.sessionId on disk lets us
 *      replay history on the user's next chat-open.
 *   2. Force the bridge client to re-resolve the engine port and open a
 *      fresh socket. Pending RPCs reject with a soft-fail — upstream
 *      retry loops handle it.
 *   3. Bump projectGeneration in the store. Project-scoped consumers
 *      (column 1's currentRoot probe, file tree, terminal) rerun their
 *      effects against the new root.
 *
 * Generation guard: any late callback from the old engine is dropped
 * because (a) the websocket is closed, so events stop arriving, and
 * (b) the in-memory sessionId → chatId map was wiped by disposeAll().
 */
function ReloadOnProjectChange() {
  const sessions = useAgentSessions();
  const bridge = useBridge();
  const dispatch = useWorkspaceDispatch();

  // Settings foundation: import the legacy localStorage settings into the
  // engine-owned TOML files once, on APP BOOT — not only when the user opens
  // Settings. Otherwise a user who never opens Settings never gets a committed
  // `.zeros/settings.toml` and the engine spawn-time reads see no settings.
  // Flag-guarded + merge-under engine-side, so calling on every bridge change
  // is safe.
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

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    // Recent projects are populated only by explicit user action
    // (Open Folder, Clone, picking a workspace from the dropdown). We
    // intentionally do NOT auto-seed from the engine root on boot —
    // the engine always boots into *some* cwd (the dev repo, or the
    // sentinel ~/.zeros/default-project for end users), and seeding
    // that into recents resurrects entries the user just cleared.
    // Fresh start = empty recents until the user picks a folder.

    onProjectChanged((payload) => {
      console.log("[Zeros] project changed", payload);
      rememberProject(payload.root);
      sessions.disposeAll();
      // Clear just the folder hint on the sticky defaults — the user
      // explicitly switched workspaces, so the next "+ New Agent"
      // should default to the new engine root, not the old workspace.
      // Agent / model / effort / permission carry over, since those
      // are about how the user likes to work, not where.
      saveStickyDefaults({ ...loadStickyDefaults(), folder: null });
      dispatch({ type: "BUMP_PROJECT_GENERATION" });
      // Fire-and-forget — the bridge will set status to "connecting"
      // immediately and any consumer waiting on a connected status
      // sees the update through useBridgeStatus.
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

/** Settings remains a full-window route with its purpose-built header. */
const COL3_COLLAPSED_KEY = "column-3-collapsed"; // gitleaks:allow — localStorage key name

// Main workspace routes are a global 40px repository/workspace bar followed by
// the two-column body. Settings retains its own full-window layout for now.
const APP_ROOT_CLS =
  "fixed inset-0 flex flex-col overflow-hidden bg-bg1 font-sans text-sm text-fg1";
const APP_BODY_CLS =
  "flex flex-1 flex-row min-h-0 min-w-0 overflow-hidden bg-bg1";

function ShellRouter() {
  // Courier the team settings layer into the engine (on connect, every
  // 15 min, and on demand after settings/membership changes). Lives here
  // because it needs the bridge (BridgeProvider is inside AppShellBody).
  useTeamEngineSync();

  // Column 3 collapse — universal across workspaces. Single persisted
  // preference; no per-workspace overrides. Previously we force-
  // collapsed when activeChatId was null (Cursor's new-agent flow
  // pattern), but the Untitled-tab redesign meant that worktree
  // welcome surfaces always opened with col3 hidden — confusing.
  // Now: only the user's explicit toggle (window-chrome icon or
  // ⌥⌘B shortcut) drives the collapse, and it applies universally.
  const [col3Collapsed, setCol3Collapsed] = React.useState<boolean>(() =>
    getSetting<boolean>(COL3_COLLAPSED_KEY, false),
  );
  const toggleCol3 = React.useCallback(() => {
    setCol3Collapsed((prev) => {
      const next = !prev;
      setSetting(COL3_COLLAPSED_KEY, next);
      return next;
    });
  }, []);

  // ⌥⌘B anywhere toggles Column 3. Skipped inside editable surfaces so
  // we don't steal from native text-input bindings (if any use ⌥⌘B).
  //
  // Match on `e.code === "KeyB"`, not `e.key`: on macOS, holding Option
  // remaps `e.key` to the glyph (Option+B → "∫"), so a letter check can
  // never match and the shortcut is simply dead — even though the palette
  // advertises it (src/shell/shortcuts-catalog.ts). Same fix the ⌥⌘T and
  // ⌥⌘F handlers below already carry; this one was missed.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
      if (e.code !== "KeyB") return;
      // Skipped inside editable surfaces — but NOT inside a focused
      // terminal (xterm's hidden textarea would otherwise swallow this
      // global chord). See src/shell/editable-target.ts.
      if (isEditableHotkeyTarget(e.target)) return;
      e.preventDefault();
      toggleCol3();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleCol3]);

  // ⌥⌘T flips the theme between light and dark. Now that the light
  // theme has shipped (2026-07-11), this toggles the *resolved*
  // variant — what's actually on screen — instead of cycling the
  // stored mode. Cycling the mode (… → system → dark → …) would
  // no-op on the common macOS setup where the OS is in dark mode:
  // "system" and "dark" resolve to the same variant, so a keypress
  // swaps between two identical-looking states and the shortcut feels
  // dead. Reading the resolved variant and switching to its opposite
  // guarantees every press produces a visible flip. ("system" stays
  // available as an explicit choice in the Settings picker.)
  //
  // Match on `e.code === "KeyT"`, not `e.key`: on macOS, holding
  // Option remaps `e.key` to the glyph (Option+T → "†"), so the
  // letter check never matches. `e.code` is the physical key and
  // is modifier-agnostic.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
      if (e.code !== "KeyT") return;
      // Skipped inside editable surfaces, but pass through a focused
      // terminal (see src/shell/editable-target.ts).
      if (isEditableHotkeyTarget(e.target)) return;
      e.preventDefault();
      // Flip what's on screen — getVariant() is the store's already-resolved
      // variant (honoring "system").
      setPrefs({ mode: getVariant() === "dark" ? "light" : "dark" });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ⌥⌘F anywhere opens the feedback dialog. One dialog instance lives HERE;
  // the shortcuts palette and any other surface summon it through the
  // feedback-controller pub/sub. Like ⌘/ it also fires inside
  // editable surfaces — the chord types nothing, and feedback is most often
  // written right after something went wrong in a composer. Match on
  // `e.code` (Option remaps `e.key` glyphs on macOS — see ⌥⌘T above).
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

  // ⌘/ anywhere toggles the glass shortcuts palette. Unlike the chords above
  // it fires inside editable surfaces too (⌘/ types nothing, and the palette
  // must open from — and close over — a focused composer). See
  // src/shell/use-shortcuts-hotkey.ts.
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const toggleShortcuts = React.useCallback(
    () => setShortcutsOpen((prev) => !prev),
    [],
  );
  useShortcutsHotkey(toggleShortcuts);

  // ⇧⌘L copies recent app logs — an INTERNAL feature; the listener only
  // attaches for allowlisted accounts with the flag on (Settings →
  // Internal). Deliberately absent from the ⌘/ catalog. See
  // src/shell/use-copy-logs-hotkey.ts.
  useCopyLogsHotkey();

  // Every route now flows through MainShellBody so the global top bar is the one
  // constant across the workspace view and the Home sub-pages (Dashboard /
  // Settings). Home renders a left nav rail beside the active sub-page; Settings
  // drops its own full-window header and mounts embedded in that content pane.
  return (
    <div className={APP_ROOT_CLS}>
      {/* AddProjectProvider wraps the shell so File → Open Folder and its
          dialogs stay available from every Home sub-page as well as the
          workspace view. */}
      <AddProjectProvider>
        <MainShellBody col3Collapsed={col3Collapsed} toggleCol3={toggleCol3} />
      </AddProjectProvider>
      {/* ⌘/ glass shortcuts palette — floats (portalled) above everything. */}
      <ShortcutsPalette open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {/* ⌥⌘F feedback dialog — the app's single instance (see above). */}
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </div>
  );
}

// 2026-05-28: when the active workspace's worktree folder has been
// removed on disk but its DB row still exists, we hide Column 2 +
// Column 3 and render the WorktreeMissingPanel in their place. The
// global top bar remains visible so another workspace is always reachable.
// Escape hatches: Delete drops the row and bounces to Local main; Refresh
// re-stats the folder so a `git worktree add` (or Finder un-trash)
// flips `present` back to true and the normal columns return.
// Local main is always present:true so this path never fires
// there — the user can never get fully stuck.
function MainShellBody({
  col3Collapsed,
  toggleCol3,
}: {
  col3Collapsed: boolean;
  toggleCol3: () => void;
}) {
  // One renderer-wide observer catches agent completions even while Column 3
  // is collapsed, Home is visible, or a missing-worktree panel replaces the
  // workspace shell. Consumers remain ordinary key subscriptions.
  useGitRefreshCoordinator();
  useDesignLintCoordinator();
  const activePage = useActivePage();
  const activeRepoId = useActiveRepoId();
  const {
    workspace: activeWorkspace,
    folder: activeWorkspaceFolder,
    project: activeProject,
  } = useActiveWorkspace();
  const pendingWorkspaceKind = usePendingWorkspaceKind(activeWorkspaceFolder);
  const activeChatMode = useWorkspaceStore(
    (state) =>
      state.chats.find((chat) => chat.id === state.activeChatId)?.mode ?? null,
  );
  const designWorkspaceActive =
    resolveWorkspacePresentationKind({
      confirmedKind: activeWorkspace?.kind,
      pendingKind: pendingWorkspaceKind,
      folder: activeWorkspaceFolder,
      chatMode: activeChatMode,
    }) === "design";
  const shellSurfaceRef = useRef<HTMLDivElement | null>(null);
  useInstantViewSwitch(
    `${activePage}:${activeWorkspace?.id ?? activeRepoId ?? activeProject?.id ?? "none"}`,
    shellSurfaceRef,
  );
  // Reveal a PR opened outside the engine (agent `gh pr create` / terminal): if
  // the active workspace has no recorded prNumber, detect + backfill it so the
  // Column 3 PR-status island appears and the header "Create PR" button hides.
  useWorkspacePrSync(activeWorkspace);
  const dispatch = useWorkspaceDispatch();
  const { projects } = useProjects();
  // ⌘T opens a chat; ⌘⇧T opens a terminal-agent tab when that feature is
  // enabled. Mounted here so neither shortcut fires from Settings.
  useNewTabHotkeys();
  const worktreeMissing =
    !!activeWorkspace && activeWorkspace.present === false;
  // Zero projects -> full-window welcome (logo + Open project / GitHub /
  // Quick start tiles) instead of the empty three-column shell.
  const showWelcome = projects.length === 0;
  // The Home tab's sub-pages share one shell: the top bar, a left nav rail
  // (HomeSidebar), and the active sub-page beside it. "repo" is the per-repo
  // page (workspaces + settings) reached from the rail's REPOS rows;
  // "customize" is agent capabilities (MCP now) scoped User / per-repo.
  const isHome =
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
    ? activePage === "settings"
      ? "settings"
      : activePage === "customize"
        ? "customize"
        : activeRepoProject
          ? "repo"
          : "dashboard"
    : null;
  // All four Home sub-pages stay mounted after their first visit, preserving
  // their local models and scroll-adjacent DOM while the active wrapper shows.
  const homePageIdsToRender = useRetainedViewKeys(activeHomePageId, 4);
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
    !showWelcome &&
    (workspaceShellRetainedRef.current || activePage === "workspace");

  // Only the workspace view swaps in the missing-worktree panel — the Home
  // sub-pages have no active worktree content to lose, so they render normally
  // even while the selected workspace's folder is gone.
  if (worktreeMissing && activeWorkspace && activePage === "workspace") {
    // Drop the DB row + worktree folder (branch kept), scrub every renderer
    // surface keyed on it, and repoint to the project's Local main so the open
    // chat isn't stranded. Shared with the corrupted-workspace archive-failure
    // toast (deleteWorkspacePermanently) so both delete paths are identical.
    const handleDelete = async () => {
      const result = await deleteWorkspacePermanently(
        activeWorkspace,
        dispatch,
      );
      if (result === "failed") {
        toast.error("Couldn't delete workspace", {
          description: "The workspace is still here — try again.",
        });
      }
    };

    // The placeholder polls this on a timer to auto-detect the worktree
    // returning: re-fetching the workspace list re-runs existsSync() on every
    // row, so a `git worktree add` (or Finder un-trash) that recreated the
    // folder flips `present` back to true and the columns reappear — no button.
    const handleRefresh = () => {
      notifyWorkspacesChanged(activeWorkspace.repoSlug);
    };

    return (
      <div
        ref={shellSurfaceRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <TopBar />
        <div className={APP_BODY_CLS}>
          <div className="text-fg1 bg-bg1 flex min-h-0 min-w-0 flex-1 overflow-hidden font-sans text-sm antialiased">
            <div className="bg-bg1 flex min-h-0 min-w-0 flex-1 overflow-hidden">
              <WorktreeMissingPanel
                workspace={activeWorkspace}
                onDelete={handleDelete}
                onRefresh={handleRefresh}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={shellSurfaceRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TopBar />
      <div className={APP_BODY_CLS}>
        <div className="text-fg1 bg-bg1 relative flex min-h-0 min-w-0 flex-1 overflow-hidden font-sans text-sm antialiased">
          {/* Workspace shell — always alive once projects exist. Home routes
              hide it without removing transcript, browser, diff, or xterm DOM. */}
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
              <Column2Workspace
                col3Collapsed={col3Collapsed}
                onToggleCol3={toggleCol3}
                surfaceActive={!isHome}
              />
              {designWorkspaceActive ? (
                <DesignWorkspaceColumn
                  workspace={
                    activeWorkspace?.kind === "design" ? activeWorkspace : null
                  }
                  folder={activeWorkspaceFolder}
                  surfaceActive={!isHome && !col3Collapsed}
                  collapsed={col3Collapsed}
                />
              ) : (
                <Column3
                  onToggleCol3={toggleCol3}
                  surfaceActive={!isHome && !col3Collapsed}
                  collapsed={col3Collapsed}
                />
              )}
            </div>
          )}
          {showWelcome && !isHome && (
            <div className="absolute inset-0 flex min-h-0 min-w-0">
              <NoProjectsView />
            </div>
          )}

          {/* Home shell — sidebar plus a lazy keep-alive deck for Dashboard,
              Settings, and the repository hub. */}
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
              {/* Settings is its own page — its section nav is the main
                  sidebar, so the Home rail is hidden there (Back returns to
                  the Home tab). Dashboard and the repo hub keep the rail. */}
              {activeHomePageId !== "settings" && <HomeSidebar />}
              <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
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
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Everything below the auth/appearance gate — the bridge + the app itself.
 *  Desktop reaches this via <AppShell> (which adds the providers + AuthGate
 *  above it). The web build (web-app.tsx) renders this DIRECTLY because its
 *  bootstrap provides AppearanceProvider/AuthProvider/AuthGate ABOVE the
 *  pairing screen, so the ordering is login → pair → app (no double-wrap). */
export function AppShellBody() {
  return (
    // Column 1's SidebarProvider previously supplied this app-wide provider as
    // a hidden side effect. Keep it at the actual app root now that the
    // sidebar is gone; every shell surface (including Settings) uses Tooltip.
    <TooltipProvider delayDuration={500} skipDelayDuration={0}>
      <BridgeProvider>
        <AgentSessionsProvider>
          {/* persisted activePage in `zeros:ui-state:v1` restores
              settings vs main workspace on reload. */}
          <HydrateAiApiKey />
          <AnalyticsBoot />
          <PreWarmAgents />
          <ReloadOnProjectChange />
          <ChatsPersistence />
          <ModelsSettingsSync />
          <ShellRouter />
        </AgentSessionsProvider>
      </BridgeProvider>
    </TooltipProvider>
  );
}

/** Above the AuthGate so a zeros://invite deep link is captured even when
 *  signed out or cold-launching (audit M3), and the pending token is dropped
 *  on sign-out so it can't bleed into the next account (audit L2). Navigation
 *  to Settings → Team is set via the store + persisted section key;
 *  harmless while signed out, and the post-sign-in mount lands there. */
function InviteDeepLinkHandler() {
  const dispatch = useWorkspaceDispatch();
  const { status } = useAuth();
  const openTeamForInvite = React.useCallback(() => {
    setSetting("settings:active-section", "user:team");
    dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
  }, [dispatch]);
  useInviteDeepLink(openTeamForInvite);
  const prevStatus = React.useRef(status);
  React.useEffect(() => {
    if (
      prevStatus.current === "authenticated" &&
      status === "unauthenticated"
    ) {
      clearPendingInviteToken();
      // Account A's team list must not render for account B (or flash the
      // Administration tabs for a zero-team next account).
      clearTeamStore();
    }
    prevStatus.current = status;
  }, [status]);
  return null;
}

export function AppShell() {
  return (
    <AppearanceProvider>
      <AuthProvider>
        {/* 01u (2026-05-20) — SINGLE app-wide toast surface. Anchored
            bottom-right. Mounts once; every transient feedback call
            (toast / toast.error / toast.success / toast.warning /
            toast.info from @/zeros/ui/primitives/elements) renders through it.
            Rule: never add new inline pills / banners for transient
            feedback — see /zeros-foundation skill + styles/zeros-foundation.md.
            Lives ABOVE the AuthGate (with UpdateNotifications) so toasts —
            in particular the auto-update toast — render on the login screen
            too, not just after sign-in. */}
        <Toaster />
        <GithubAppNotifications />
        {/* Above the gate so a main-process-staged update can notify on the
            login screen too. Main owns checking/downloading even with no
            renderer; useAnyAgentRunning reads a global Zustand store, so no
            provider below the gate is required. */}
        <UpdateNotifications />
        <InviteDeepLinkHandler />
        <AuthGate>
          <AppShellBody />
        </AuthGate>
      </AuthProvider>
    </AppearanceProvider>
  );
}

export default AppShell;
