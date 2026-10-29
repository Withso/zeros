// One agent session per ChatThread, scoped to its folder and agent. Recent views
// stay in ConversationPaneLayout's bounded retained deck; this component always
// reads its explicit chatId. An agentless chat auto-binds to the resolved
// default, terminal chats render nothing here because TerminalDeck owns their
// PTY, and the session starts lazily once the view mounts with an agent.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  useChatById,
  usePendingAutoSend,
  useWorkspaceDispatch,
  type ChatThread,
} from "../../state/store";
import { useWorkspaceStore } from "../../state/workspace-store";
import { folderIsWithinRoot } from "../../state/workspace-resolution";
import {
  getLiveChatDraft,
  liveChatDraftHasText,
  subscribeToLiveChatDrafts,
} from "../../features/agent/composer-live-drafts";
import {
  useAgentSessions,
  useChatSession,
} from "../../features/agent/sessions-hooks";
import { useSessionsStore } from "../../features/agent/sessions-store";
import { paintTranscriptFromMemory } from "../../features/agent/local-transcript-presentation";
import { useBridgeStatus } from "../../platform/bridge/use-bridge";
import { AgentChat } from "../../features/agent/agent-chat";
import { agentFamily, envForChat } from "../../features/agent/model-catalog";
import { agentAppliesConfigLive } from "../../features/agent/live-config-support";
import { useDefaultAgent } from "../../features/settings/default-agent";
import {
  hasConfirmedAgents,
  loadAgents,
} from "../../features/agent/agents-cache";
import { useWorkspaceAgents, hasConfirmedWorkspaceAgents } from "../../features/agent/workspace-agent-registry";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { hasUntitledChatName } from "../../features/agent/pristine-chat";
import { useEnabledAgents } from "../../features/agent/enabled-agents";
import { isRemovedAgent } from "../../features/agent/agent-runnable";
import { AgentRemovedPanel } from "../agent-removed-panel";
import { NoFolderPanel } from "../no-folder-panel";
import { useChatCwd } from "../use-chat-cwd";
import { useWorkspaceProvisioning } from "../../state/pending-workspaces";
import { finishPreparedChatView } from "./chat-intent";
import {
  adoptedPristineSpawnBind,
  INITIAL_PRISTINE_SPAWN_BIND,
  nextPristineSpawnDecision,
  type PristineSpawnBind,
} from "./pristine-agent-switch";
import { deferBootSessionAdmission } from "./lazy-boot-resume";
import {
  rememberProvisionalBinding,
  resolveAutoBindChatSettings,
  takeProvisionalBinding,
  type PriorChatIdentity,
} from "./auto-bind-chat";
import {
  legacyProviderBinding,
  sameProviderBinding,
  sameProviderMetadata,
} from "@zeros/protocol/identities";

export function ChatView({
  chatId,
  surfaceActive = true,
  preparing = false,
  readOnly = false,
  composerReplacement,
}: {
  chatId: string;
  surfaceActive?: boolean;
  /** True only while pointer/focus intent is building a hidden cold view. */
  preparing?: boolean;
  readOnly?: boolean;
  composerReplacement?: React.ReactNode;
}) {
  // The displayed chat is an explicit prop, so each split pane shows its own.
  const active = useChatById(chatId);
  const dispatch = useWorkspaceDispatch();
  const cloud = isCloudWorkspace(active?.folder);
  // Hidden cloud preparation may consume retained registry data and hydrate
  // history, but a registry request would claim its speculative runtime peer.
  const agents = useWorkspaceAgents(active?.folder, surfaceActive || (!cloud && preparing));
  const bindingActive = !readOnly && (surfaceActive || !cloud);
  // Resolve cwd as the chat's folder or the selected worktree scope
  // (newAgentFolder), like useChatCwd and the topbar. A chat with an empty folder
  // would otherwise fail to spawn ("chat has no project folder bound") and
  // disable the composer.
  const resolvedCwd = useChatCwd();
  // A binding made before the registry answered is a guess. Correct it here —
  // this hook outlives AutoBindAgent, which unmounts the instant it binds.
  useProvisionalBindingReconcile(active, bindingActive);

  if (!active) {
    return null;
  }

  // TerminalDeck owns the PTY and xterm grid, so the shell survives chat-tab
  // switches, pane moves and retained-chat eviction.
  if (active.kind === "terminal") {
    return null;
  }

  // Auto-bind an agentless chat to the resolved default. App-shell hydration
  // backfills persisted records, so this only catches edge cases.
  if (!readOnly && !active.agentId) {
    return bindingActive ? <AutoBindAgent chat={active} /> : null;
  }

  // The bound agent was removed from the product (first case: `gemini`). Show a
  // dead-end card whose "Switch agent" clears the binding so AutoBindAgent
  // rebinds. Gated on a loaded registry so a cold start can't flash it.
  if (!readOnly && active.agentId && isRemovedAgent(active.agentId, agents)) {
    return (
      <AgentRemovedPanel
        agentId={active.agentId}
        agentName={active.agentName}
        onSwitchAgent={() =>
          dispatch({
            type: "UPDATE_CHAT_SETTINGS",
            id: active.id,
            updates: { agentId: null, agentName: null, sessionId: undefined },
          })
        }
      />
    );
  }

  const cwd = active.folder || resolvedCwd || "";
  // Never hand an empty cwd to the session layer: the gateway would fail every
  // agent with "no project folder bound" and a dead composer. Show a
  // pick-a-folder panel instead; binding a folder re-renders into ChatBody.
  if (!readOnly && !cwd) {
    return <NoFolderPanel chatId={active.id} />;
  }

  return (
    <ChatBody
      chatId={active.id}
      agentId={active.agentId ?? ""}
      agentName={active.agentName ?? active.agentId ?? ""}
      cwd={cwd}
      surfaceActive={surfaceActive}
      preparing={preparing}
      readOnly={readOnly}
      composerReplacement={composerReplacement}
    />
  );
}

/** The identity a repaired record carries into rebinding: its former agent
 *  name, its resumable session, and the composer configuration that was written
 *  in the same update as the `agentId` it lost. */
function priorIdentityOf(chat: ChatThread): PriorChatIdentity {
  return {
    agentName: chat.agentName,
    sessionId: chat.sessionId,
    providerBinding: chat.providerBinding,
    providerMetadata: chat.providerMetadata,
    model: chat.model,
    effort: chat.effort,
    fast: chat.fast,
    permissionMode: chat.permissionMode,
    lastModeId: chat.lastModeId,
  };
}

/** Binds an agentless chat to the resolved default in a layout effect, so the
 *  composer is the first thing painted. Priority mirrors `pickAgentForNewChat`
 *  and relaxes down to best-detected, so the registry always binds. Binding
 *  never waits for the live registry: a cold-cache guess is recorded by
 *  {@link rememberProvisionalBinding} and corrected by
 *  {@link useProvisionalBindingReconcile}. Holding the pane behind a spinner
 *  would be the hidden data waterfall AGENTS.md forbids. */
function AutoBindAgent({ chat }: { chat: ChatThread }) {
  const dispatch = useWorkspaceDispatch();
  const { agentId: starredId } = useDefaultAgent();
  const { isEnabled } = useEnabledAgents();
  const agents = useWorkspaceAgents(chat.folder);
  // Latch so the settings update this triggers cannot make the effect
  // double-write the chat on its immediate re-render.
  const boundRef = useRef(false);

  useLayoutEffect(() => {
    if (boundRef.current) return;
    boundRef.current = true;
    const prior = priorIdentityOf(chat);
    // An UNCONFIRMED snapshot means the binding is a guess; record what the chat
    // looked like BEFORE it so the reconcile pass can re-resolve faithfully.
    // Unconfirmed covers more than a cold null: the cache publishes `[]` when a
    // load fails with nothing on disk, and that array reads exactly like an
    // authoritative empty registry while being nothing of the sort.
    if (!hasConfirmedWorkspaceAgents(chat.folder)) rememberProvisionalBinding(chat.id, prior);
    // Several ChatViews are mounted at once in a split workspace. Updating
    // this one chat must not use HYDRATE_CHATS with `activeChatId: chat.id`:
    // an agentless chat in a background pane would steal keyboard/composer
    // focus as soon as its passive effect ran.
    dispatch({
      type: "UPDATE_CHAT_SETTINGS",
      id: chat.id,
      updates: resolveAutoBindChatSettings(agents, starredId, isEnabled, prior),
    });
    // Bind from the FIRST render's values deliberately. A later registry answer
    // is applied by useProvisionalBindingReconcile, which knows to leave a
    // started chat alone; re-running here would restamp the record underneath
    // a user who is already typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

/** Replace a binding that was guessed without the registry once the
 *  authoritative list arrives. Lives on ChatView (not AutoBindAgent, which
 *  unmounts the moment it binds) and runs at most once per chat.
 *
 *  A chat that already minted a session keeps its guess: swapping the agent
 *  under a live session is worse than an imperfect first pick, and the pill
 *  lets the user move it. */
function useProvisionalBindingReconcile(
  chat: ChatThread | null,
  enabled: boolean,
): void {
  const dispatch = useWorkspaceDispatch();
  const { agentId: starredId } = useDefaultAgent();
  const { isEnabled } = useEnabledAgents();
  const agents = useWorkspaceAgents(chat?.folder, enabled);
  const sessions = useAgentSessions();
  const bridgeStatus = useBridgeStatus(chat?.folder);
  const chatId = chat?.kind === "chat" ? chat.id : null;
  const boundAgentId = chat?.agentId ?? null;
  const hasSession = Boolean(chat?.providerBinding ?? chat?.sessionId);

  // AgentChat owns the cache's routine loader and never mounts while a chat is
  // agentless, so kick the load here on a cold cache. Gated on a connected bridge
  // so a boot blip doesn't become a spurious `[]`. Keyed on confirmation, not
  // `agents !== null`: a failed load publishes `[]`, and identical snapshots let
  // React bail out, so retries stay bounded.
  useEffect(() => {
    if (!enabled) return;
    if (isCloudWorkspace(chat?.folder) || hasConfirmedAgents() || bridgeStatus !== "connected") return;
    void loadAgents((force) => sessions.listAgents(force)).catch(() => {
      /* still unconfirmed; the next snapshot or bridge flip tries again */
    });
  }, [enabled, agents, bridgeStatus, sessions, chat?.folder]);

  useEffect(() => {
    if (
      !enabled ||
      !agents ||
      !hasConfirmedWorkspaceAgents(chat?.folder) ||
      !chatId ||
      !boundAgentId
    )
      return;
    // The provisional record is ONE-SHOT. Reading it against a list the cache
    // never confirmed would spend a chat's only chance at repair on the very
    // registry that cannot repair anything.
    const prior = takeProvisionalBinding(chatId);
    if (!prior || hasSession) return;
    const settings = resolveAutoBindChatSettings(
      agents,
      starredId,
      isEnabled,
      prior,
    );
    // The guess was right about the provider ⇒ leave the chat's model/effort/
    // Fast alone rather than restamping identical values. Extension agents have
    // no family, so they are compared by exact id instead of both resolving to
    // "" and passing for each other.
    const resolvedFamily = agentFamily(settings.agentId);
    const sameAgent =
      settings.agentId === boundAgentId ||
      (resolvedFamily !== "" && resolvedFamily === agentFamily(boundAgentId));
    if (sameAgent) return;
    dispatch({
      type: "UPDATE_CHAT_SETTINGS",
      id: chatId,
      updates: settings,
    });
  }, [
    enabled,
    agents,
    chat?.folder,
    boundAgentId,
    chatId,
    dispatch,
    hasSession,
    isEnabled,
    starredId,
  ]);
}

function ChatBody({
  chatId,
  agentId,
  agentName,
  cwd,
  surfaceActive,
  preparing,
  readOnly,
  composerReplacement,
}: {
  chatId: string;
  agentId: string;
  agentName: string;
  cwd: string;
  surfaceActive: boolean;
  preparing: boolean;
  readOnly: boolean;
  composerReplacement?: React.ReactNode;
}) {
  const dispatch = useWorkspaceDispatch();
  const pendingAutoSend = usePendingAutoSend(chatId);
  const workspaceProvisioning = useWorkspaceProvisioning(cwd);
  const session = useChatSession(
    chatId,
    surfaceActive || (!readOnly && (preparing || pendingAutoSend)),
    !readOnly,
  );
  const [historyError, setHistoryError] = useState<string | null>(null);
  // Keep only this persistence-critical scalar live while the expensive
  // retained transcript is parked. A session created just before a workspace
  // switch must still be linked to its chat even if the chat is never revealed
  // again before application shutdown.
  const liveProviderBinding = useSessionsStore((state) => {
    const slot = state.sessions[chatId];
    return slot?.providerBinding ?? null;
  });
  const liveProviderMetadata = useSessionsStore(
    (state) => state.sessions[chatId]?.providerMetadata ?? null,
  );
  const chat = useChatById(chatId);

  // Serialize the env tuple so the effect only fires on a real
  // user-facing change, not on every store update. Includes the extra dirs
  // (Claude /add-dir) so adding/removing one respawns the session (which
  // resumes, so the conversation survives) to apply additionalDirectories.
  const envKey = chat
    ? `${chat.model ?? ""}|${chat.effort}|${chat.fast ? "1" : "0"}|${JSON.stringify(chat.additionalDirectories ?? [])}`
    : "";
  const envKeyRef = useRef(envKey);
  // Which agent this view has actually bound, and whether a pristine agent
  // switch has already been deferred (pristine-agent-switch.ts owns the rule).
  // ChatBody is not keyed by chatId, so this is scoped to the chat it was
  // recorded for and reset when the view is pointed at a different one.
  const bindRef = useRef<{ chatId: string; bind: PristineSpawnBind }>({
    chatId,
    bind: INITIAL_PRISTINE_SPAWN_BIND,
  });
  if (bindRef.current.chatId !== chatId) {
    bindRef.current = { chatId, bind: INITIAL_PRISTINE_SPAWN_BIND };
  }
  // Lazy boot resume (lazy-boot-resume.ts): only the workspace's focused
  // conversation may MINT an execution on mount. Other surfaced panes re-adopt
  // if the engine still owns one and otherwise stay idle until touched. Read as
  // a live selector so a pane becoming focused re-runs the spawn effect below.
  const isFocusedChat = useWorkspaceStore(
    (state) => state.activeChatId === chatId,
  );
  const navigationOnly = useWorkspaceStore((state) =>
    state.localLinkNavigation?.passive && folderIsWithinRoot(cwd, state.localLinkNavigation.workspace.path));

  // Typing is intent, and it is the earliest honest signal of it. A deferred
  // pristine-switch spawn starts here rather than at Send, so the admission
  // overlaps the typing and the eventual send is accepted into the queued-
  // message card instead of blocking on a spinner. One-way per chat: it only
  // ever arms the spawn, so it cannot thrash. Seeded from the persisted draft
  // for a chat reopened with text already in it.
  const [composerHasText, setComposerHasText] = useState(() =>
    liveChatDraftHasText(
      getLiveChatDraft(chatId) ??
        useWorkspaceStore.getState().chatComposerDrafts[chatId] ??
        null,
    ),
  );
  const composerTextChatRef = useRef(chatId);
  if (composerTextChatRef.current !== chatId) {
    composerTextChatRef.current = chatId;
    setComposerHasText(
      liveChatDraftHasText(
        getLiveChatDraft(chatId) ??
          useWorkspaceStore.getState().chatComposerDrafts[chatId] ??
          null,
      ),
    );
  }
  useEffect(() => {
    if (readOnly || composerHasText) return;
    return subscribeToLiveChatDrafts((draftChatId, draft) => {
      if (draftChatId !== chatId || !liveChatDraftHasText(draft)) return;
      setComposerHasText(true);
    });
  }, [chatId, composerHasText, readOnly]);

  // Initial spawn (idempotent): ensureSession short-circuits when the same
  // (chatId, agentId) is ready, and a persisted provider binding resumes instead.
  const sessions = useAgentSessions();
  // Publish a remembered transcript before this view's first visible
  // paint, so a chat that left the retained deck reopens with its content
  // instead of a blank frame or "Loading conversation…". Provisional and
  // read-only; the hydrate below confirms it through the engine.
  const paintFolder = chat?.folder ?? cwd;
  useLayoutEffect(() => {
    // Idempotent: a resident or already painted transcript is left alone.
    if (surfaceActive || preparing) paintTranscriptFromMemory(chatId, paintFolder);
  }, [chatId, paintFolder, surfaceActive, preparing]);
  const hasSessionSlot = useSessionsStore((state) => state.sessions[chatId] !== undefined);
  const hasChatMetadata = Boolean(chat);
  // Cloud history belongs to the database, including during stop/wake/setup.
  // Authentication can also clear a slot while its view stays retained under
  // the same chat id. Hydrate once authorized metadata is available, separately
  // from agent admission below. Local creation still waits for its filesystem.
  useEffect(() => {
    if (!surfaceActive || !hasChatMetadata || hasSessionSlot ||
        (!readOnly && workspaceProvisioning && !isCloudWorkspace(cwd))) return;
    let cancelled = false;
    void sessions.hydrateChat(chatId).then(() => {
      // Cleanup may have removed the slot while an earlier shared read was
      // retiring. That read cannot publish into an absent slot. Retry once
      // after its request identity is released, provided this view still owns
      // the same authorized chat. Do not turn ordinary failures into polling.
      if (!cancelled && !sessions.getSession(chatId))
        return sessions.hydrateChat(chatId);
    }).catch(() => {
      if (!cancelled && readOnly) setHistoryError("Couldn't load chat history.");
    });
    return () => { cancelled = true; };
  }, [chatId, cwd, hasChatMetadata, hasSessionSlot, surfaceActive, readOnly, workspaceProvisioning, sessions]);
  // Optimistic create: render the provisional composer immediately, but do not
  // spawn into the announced path until the exact create lifecycle publishes.
  // Workbench's longer presentation-only settling window is deliberately not a
  // session gate.
  useEffect(() => {
    if (readOnly && !surfaceActive) return;
    if (!surfaceActive && !pendingAutoSend) {
      // Intent-prepared chats build transcript/composer DOM from disk, but a
      // hover must never spawn or resume an agent subprocess.
      if (preparing) {
        void session
          .hydrateChat()
          .finally(() => finishPreparedChatView(chatId));
      }
      return;
    }
    if (!readOnly && workspaceProvisioning) return;
    let cancelled = false;
    // Await the disk hydrate before spawning: ensureSession resets the slot from its
    // existing messages, so spawning first would flash an empty transcript and
    // could drop the optimistic bubble. Hydrate is a no-op when the slot has
    // messages.
    void (async () => {
      await session.hydrateChat();
      if (cancelled) return;
      setHistoryError(null);
      if (readOnly) return;

      // Provider already has a live session for this chat — nothing to do.
      // Re-read fresh after the await rather than the captured snapshot.
      const existing = sessions.getSession(chatId);
      if (
        existing?.sessionId &&
        existing.status !== "failed" &&
        existing.status !== "reconnecting"
      ) {
        envKeyRef.current = envKey;
        bindRef.current = { chatId, bind: adoptedPristineSpawnBind(agentId) };
        return;
      }

      // Stepping through the agent picker on a chat that was never used must
      // not pay a boundary admission per hop. pristine-agent-switch.ts owns
      // the rule and its sticky bookkeeping; a deferred spawn lands on first
      // use instead, which agent-chat's send path already self-heals.
      const spawnDecision = nextPristineSpawnDecision({
        agentId,
        bind: bindRef.current.bind,
        hasTranscript: existing?.hasTranscript ?? false,
        messageCount: existing?.messages.length ?? 0,
        chatTitle: chat && hasUntitledChatName(chat) ? "Untitled" : chat?.title,
        pendingAutoSend,
        composerHasText,
      });
      bindRef.current = { chatId, bind: spawnDecision.bind };
      if (spawnDecision.defer) {
        envKeyRef.current = envKey;
        return;
      }

      const env = chat ? envForChat(chat, session.initialize) : undefined;
      const persistedProviderBinding =
        (chat?.providerBinding?.providerId === agentId
          ? chat.providerBinding
          : undefined) ??
        (chat?.sessionId
          ? legacyProviderBinding(agentId, chat.sessionId)
          : undefined);
      // An unfocused, untouched pane may re-adopt but never mint. See
      // lazy-boot-resume.ts for why, and AgentLoadSessionMessage.adoptOnly for
      // what the engine does with it.
      const adoptOnly = deferBootSessionAdmission({
        navigationOnly,
        isFocusedChat,
        pendingAutoSend,
        composerHasText,
        preparing,
      });
      // Pass cwd verbatim so the gateway can surface
      // "no project folder bound" as an explicit error instead of silently
      // falling back to engine projectRoot.
      if (persistedProviderBinding) {
        // Tell the engine the provider's durable binding; the engine either
        // re-adopts this conversation's live execution or mints a fresh one.
        void sessions
          .loadIntoChat(chatId, agentId, persistedProviderBinding, {
            agentName,
            cwd,
            env,
            ...(adoptOnly ? { adoptOnly: true } : {}),
          })
          .then((adopted) => {
            if (cancelled || adopted) return;
            // Adopt-only miss: nothing was admitted and nothing was learned
            // about the binding. Leave the chat idle with its transcript and
            // resume id intact — it admits for real on focus/keystroke/send.
            if (adoptOnly) return;
            // A definitive provider "not found" is the only load failure that
            // invalidates durable identity. Clear all compatibility mirrors
            // before creating the replacement so the broken handle cannot be
            // reintroduced by persistence or the next mount.
            dispatch({
              type: "UPDATE_CHAT_SETTINGS",
              id: chatId,
              updates: {
                providerBinding: undefined,
                providerMetadata: undefined,
                sessionId: undefined,
              },
            });
            void session.ensureSession(agentId, { agentName, cwd, env });
          });
      } else {
        const hasPriorContext =
          existing?.hasTranscript === true ||
          (existing?.messages.length ?? 0) > 0;
        if (!hasPriorContext && !navigationOnly) {
          // Nothing durable to adopt and nothing on screen to keep warm — an
          // unfocused pane in that state simply waits for its first touch.
          if (!adoptOnly) {
            void session.ensureSession(agentId, { agentName, cwd, env });
          }
        } else {
          // Probe by Zeros conversation id first. A renderer reload can lose
          // its volatile execution route before a newly-learned provider
          // binding was persisted; the engine can still reattach it. Only a
          // confirmed miss creates a new execution.
          void sessions
            .loadIntoChat(chatId, agentId, null, {
              agentName,
              cwd,
              env,
              ...(adoptOnly ? { adoptOnly: true } : {}),
            })
            .then((adopted) => {
              if (cancelled || adopted || adoptOnly) return;
              void session.ensureSession(agentId, { agentName, cwd, env });
            });
        }
      }
      envKeyRef.current = envKey;
    })().catch((error) => {
      if (!readOnly) throw error;
      if (!cancelled && readOnly)
        setHistoryError("Couldn't load chat history.");
    });
    return () => {
      cancelled = true;
    };
    // We only want this to fire when the identity triple changes, not
    // on every render or when session internals shuffle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    readOnly,
    navigationOnly,
    chatId,
    agentId,
    cwd,
    surfaceActive,
    preparing,
    pendingAutoSend,
    workspaceProvisioning,
    // Re-runs once, on the first keystroke, to start a deferred spawn. It only
    // ever transitions false → true per chat, so this cannot loop.
    composerHasText,
    // Re-runs when this pane becomes (or stops being) the focused conversation,
    // which is what ends a lazy-boot deferral. A chat that already admitted has
    // a live session and takes the early-return above, so refocusing is cheap.
    isFocusedChat,
  ]);

  // Persist only the provider binding. The Zeros execution id stays in the
  // live session store and is intentionally absent from durable chat state.
  useEffect(() => {
    if (readOnly || !chat) return;
    const binding = liveProviderBinding;
    const providerMetadataChanged =
      liveProviderMetadata !== null &&
      !sameProviderMetadata(liveProviderMetadata, chat.providerMetadata);
    if (
      binding &&
      (!sameProviderBinding(binding, chat.providerBinding) ||
        providerMetadataChanged)
    ) {
      dispatch({
        type: "UPDATE_CHAT_SETTINGS",
        id: chatId,
        updates: {
          providerBinding: binding,
          ...(liveProviderMetadata
            ? { providerMetadata: liveProviderMetadata }
            : {}),
          // Downgrade mirror only. Current code never reads it as a route.
          sessionId: binding.legacySessionId ?? binding.resumeId,
        },
      });
    }
  }, [
    readOnly,
    chatId,
    liveProviderBinding,
    liveProviderMetadata,
    chat,
    dispatch,
  ]);

  // Respawn on a model/effort change only for agents that cannot apply it live
  // (agent/live-config-support.ts). Claude and Codex get the change through
  // agent-chat's pill handlers; respawning them duplicated work, fired concurrent
  // spawns (`force` bypasses ensureSession's de-dup) and rebuilt a cold session
  // that lost the conversation and its resumable binding. For the rest,
  // sendPrompt's settings-drift reconcile (sessions-provider.tsx) respawns at
  // send time if a live apply never landed (see appliedChatEnvKey).
  useEffect(() => {
    if (readOnly || navigationOnly || !surfaceActive) return;
    if (envKey === envKeyRef.current) return;
    // Bail before stamping: a change that lands while `chat` is momentarily null
    // must not be recorded as applied and swallowed.
    if (!chat) return;
    envKeyRef.current = envKey;
    if (agentAppliesConfigLive(agentId)) return;
    void session.ensureSession(agentId, {
      agentName,
      // Verbatim cwd, so the gateway reports a missing folder instead of falling back
      // to the engine projectRoot.
      cwd,
      env: envForChat(chat, session.initialize),
      force: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envKey, surfaceActive, readOnly, navigationOnly]);

  // Retry once per reconnect, on the rising edge to "connected": a chat whose
  // initial load hit a transient bridge error (queue full mid-respawn, a load
  // timeout during an engine restart) otherwise sits in `failed` until the user
  // clicks away and back.
  const bridgeStatus = useBridgeStatus(cwd);
  const lastBridgeStatusRef = useRef(bridgeStatus);
  useEffect(() => {
    const prev = lastBridgeStatusRef.current;
    lastBridgeStatusRef.current = bridgeStatus;
    if (readOnly) return;
    if (!surfaceActive && !pendingAutoSend) return;
    if (prev === "connected" || bridgeStatus !== "connected") return;
    if (!chat) return;
    if (session.status !== "failed" && session.status !== "reconnecting")
      return;
    let cancelled = false;
    const env = envForChat(chat, session.initialize);
    const persistedProviderBinding =
      (chat.providerBinding?.providerId === agentId
        ? chat.providerBinding
        : undefined) ??
      (chat.sessionId
        ? legacyProviderBinding(agentId, chat.sessionId)
        : undefined);
    if (persistedProviderBinding) {
      void sessions.loadIntoChat(chatId, agentId, persistedProviderBinding, {
        agentName,
        // Verbatim cwd, so the gateway reports a missing folder instead of falling back
        // to the engine projectRoot.
        cwd,
        env,
        ...(navigationOnly ? { adoptOnly: true } : {}),
      });
    } else {
      void sessions
        .loadIntoChat(chatId, agentId, null, { agentName, cwd, env, ...(navigationOnly ? { adoptOnly: true } : {}) })
        .then((adopted) => {
          if (cancelled || adopted || navigationOnly) return;
          void session.ensureSession(agentId, { agentName, cwd, env });
        });
    }
    return () => {
      cancelled = true;
    };
    // We deliberately exclude `session` from deps — its identity
    // changes on every state update and would re-fire this loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    readOnly,
    navigationOnly,
    bridgeStatus,
    chatId,
    agentId,
    agentName,
    cwd,
    pendingAutoSend,
    surfaceActive,
  ]);

  return (
    <>
      {readOnly && historyError && (
        <p className="text-red-fg px-7 py-2 text-xs" role="alert">
          {historyError}
        </p>
      )}
      <AgentChat
        liveTextUpdates={!readOnly}
        readOnly={readOnly}
        composerReplacement={composerReplacement}
        session={session}
        onBack={() => session.reset()}
        headerActions={<></>}
        chatId={chatId}
        surfaceActive={surfaceActive}
        workspaceProvisioning={workspaceProvisioning}
      />
    </>
  );
}
