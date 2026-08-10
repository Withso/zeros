// ──────────────────────────────────────────────────────────
// Conversation pane — Chat view (per-chat native agent session)
// ──────────────────────────────────────────────────────────
//
// Replaces the Phase-0 AIChatPanel in Conversation pane's Chat tab. Each
// ChatThread in the store gets its own agent session, scoped to
// the chat's folder and agent. Recent views live in ConversationPaneLayout' bounded
// retained deck, so switching hides/shows complete transcript trees while
// this component continues to read its explicit chatId.
//
// Four states:
//   - no active chat            → null (EmptyComposer landing deleted
//                                 2026-06-18; replacement lands via the
//                                 redesign branch on merge to main)
//   - chat kind w/o agent       → AUTO-BIND to the resolved default
//                                 (explicit → Codex → Claude → Cursor → first)
//                                 then re-render as ChatBody. The
//                                 user never sees a picker; 2026-05-23
//                                 the legacy NoAgentView path was
//                                 retired because the product rule is
//                                 "every chat always has an agent".
//   - chat kind w/ agent        → AgentChat (messages + composer)
//   - terminal kind             → return null; body owned by the
//                                 TerminalDeck sibling so the
//                                 PTY survives chat-tab switches.
//
// Lazy start: the session isn't created until the view mounts
// with a chat that has an agentId — typing a prompt warms the
// subprocess at composer-focus time (handled by AgentChat).
// ──────────────────────────────────────────────────────────

import React, { useEffect, useLayoutEffect, useRef } from "react";
import {
  useChatById,
  usePendingAutoSend,
  useWorkspaceDispatch,
  type ChatThread,
} from "../../state/store";
import {
  useAgentSessions,
  useChatSession,
} from "../../features/agent/sessions-hooks";
import { useSessionsStore } from "../../features/agent/sessions-store";
import { useBridgeStatus } from "../../platform/bridge/use-bridge";
import { AgentChat } from "../../features/agent/agent-chat";
import { agentFamily, envForChat } from "../../features/agent/model-catalog";
import { agentAppliesConfigLive } from "../../features/agent/live-config-support";
import { useDefaultAgent } from "../../features/settings/default-agent";
import {
  hasConfirmedAgents,
  loadAgents,
  useAgentsSnapshot,
} from "../../features/agent/agents-cache";
import { useEnabledAgents } from "../../features/agent/enabled-agents";
import { isRemovedAgent } from "../../features/agent/agent-runnable";
import { AgentRemovedPanel } from "../agent-removed-panel";
import { NoFolderPanel } from "../no-folder-panel";
import { useChatCwd } from "../use-chat-cwd";
import { useWorkspaceProvisioning } from "../../state/pending-workspaces";
import { finishPreparedChatView } from "./chat-intent";
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
}: {
  chatId: string;
  surfaceActive?: boolean;
  /** True only while pointer/focus intent is building a hidden cold view. */
  preparing?: boolean;
}) {
  // Split panes (2026-07-17): the displayed chat is an explicit prop —
  // each pane passes its own — instead of the global active chat (the
  // panes container derives per-pane display from the layout model).
  const active = useChatById(chatId);
  const dispatch = useWorkspaceDispatch();
  const agents = useAgentsSnapshot();
  // Canonical cwd resolution: the chat's own `folder` OR the current scope
  // (`newAgentFolder` — the worktree row the user has selected). Same chain
  // as useChatCwd / repository panel / the topbar. Without the fallback, a chat with
  // an empty `folder` (created via a path that didn't bind one — e.g. the
  // command palette, or a pre-folder persisted record) dropped the active
  // scope and the gateway threw "Agent cannot spawn: chat has no project
  // folder bound", which put the session in isErrorState and DISABLED the
  // composer. Resolving to the active scope here lets the spawn succeed in
  // the folder the user is actually in (not the engine root — that footgun
  // is avoided because newAgentFolder is the user's selected worktree).
  const resolvedCwd = useChatCwd();
  // A binding made before the registry answered is a guess. Correct it here —
  // this hook outlives AutoBindAgent, which unmounts the instant it binds.
  useProvisionalBindingReconcile(active);

  if (!active) {
    // EmptyComposer (the no-chat "start a new chat" landing) no longer exists
    // in this worktree.
    // The replacement for the no-active-chat state ships on the redesign branch
    // and reconciles on merge to main; until then this renders nothing.
    return null;
  }

  // Terminal-kind chat — the PTY + xterm grid live in
  // TerminalDeck (a sibling of this component in
  // ConversationPane) so they survive chat-tab switches. This
  // TerminalSessionView still belongs to the always-mounted terminal deck so
  // the shell survives pane moves and retained-chat eviction.
  if (active.kind === "terminal") {
    return null;
  }

  // Chat has no agent bound yet — auto-bind to the resolved default
  // (explicit → Codex → Claude → Cursor → first runnable) and re-render as ChatBody.
  // The hydration step in app-shell.tsx already backfills persisted
  // records, so this branch only catches edge cases (a brand-new
  // chat created elsewhere, a corrupted record bypassing migration).
  if (!active.agentId) {
    return <AutoBindAgent chat={active} />;
  }

  // The chat is bound to an agent the registry no longer knows about —
  // the adapter was removed from the product (first case: the retired
  // `gemini` CLI). Don't attempt a doomed spawn; show a dead-end card
  // whose "Switch agent" clears the dead binding so AutoBindAgent rebinds
  // the resolved default. Gated on a loaded registry (isRemovedAgent
  // returns false while `agents` is null) so a cold start can't flash
  // this over a still-resolving agent.
  if (isRemovedAgent(active.agentId, agents)) {
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
  // Keystone guard (Bug 1): never hand an empty cwd to the session layer.
  // The gateway throws "Agent cannot spawn: chat has no project folder
  // bound" on an empty cwd, which surfaces as a red "Agent error" pill +
  // a dead composer for every agent (cursor, codex, …). This single
  // check catches a folderless chat from ANY entry point — a brand-new
  // user who typed before picking a folder, a stale persisted record
  // whose folder never resolved, an all-workspaces-closed state — and
  // shows a pick-a-folder panel instead. Binding a folder flips cwd
  // non-empty and re-renders into ChatBody, which spawns normally.
  if (!cwd) {
    return <NoFolderPanel chatId={active.id} />;
  }

  return (
    <ChatBody
      chatId={active.id}
      agentId={active.agentId}
      agentName={active.agentName ?? active.agentId}
      cwd={cwd}
      surfaceActive={surfaceActive}
      preparing={preparing}
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

/** Side-effect component: when mounted with a chat that has no agentId,
 *  resolves the default and writes it back to the store. The write happens in a
 *  LAYOUT effect, so React re-renders into ChatBody before this frame paints —
 *  the composer is the first thing the user sees, not an intermediate state.
 *
 *  The lookup priority mirrors `pickAgentForNewChat` in default-agent.ts:
 *  explicit default > Codex > Claude > Cursor > first, relaxing from
 *  enabled+runnable down to best-detected so the registry ALWAYS binds — a
 *  machine with nothing signed in gets the composer's "Sign in required" flow,
 *  never a dead pane.
 *
 *  Binding does NOT wait for the live registry. The agents cache hydrates its
 *  snapshot from localStorage at module load, so it is usually already warm;
 *  when it is genuinely cold (true first run) the product chain resolves the
 *  guess, {@link rememberProvisionalBinding} records it, and
 *  {@link useProvisionalBindingReconcile} corrects it as soon as the
 *  authoritative list lands. Holding the pane behind a spinner + timeout
 *  instead would be exactly the hidden data waterfall AGENTS.md forbids. */
function AutoBindAgent({ chat }: { chat: ChatThread }) {
  const dispatch = useWorkspaceDispatch();
  const { agentId: starredId } = useDefaultAgent();
  const { isEnabled } = useEnabledAgents();
  const agents = useAgentsSnapshot();
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
    if (!hasConfirmedAgents()) rememberProvisionalBinding(chat.id, prior);
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
function useProvisionalBindingReconcile(chat: ChatThread | null): void {
  const dispatch = useWorkspaceDispatch();
  const { agentId: starredId } = useDefaultAgent();
  const { isEnabled } = useEnabledAgents();
  const agents = useAgentsSnapshot();
  const sessions = useAgentSessions();
  const bridgeStatus = useBridgeStatus();
  const chatId = chat?.kind === "chat" ? chat.id : null;
  const boundAgentId = chat?.agentId ?? null;
  const hasSession = Boolean(chat?.providerBinding ?? chat?.sessionId);

  // The cache's only routine loader lives in AgentChat, which never mounts
  // while a chat is agentless. On a cold cache (fresh install, new dev data
  // dir) nothing else fills the snapshot, so kick the load here. Gated on a
  // connected bridge (same idiom as settings-page) so a boot-time blip doesn't
  // convert into a spurious `[]` registry; the status flip re-runs this.
  //
  // Keyed on CONFIRMATION, not on `agents !== null`: a failed load leaves a
  // published `[]` behind, and stopping there meant nothing ever asked the
  // engine again. Re-running is bounded by the snapshot's own reference —
  // repeated failures keep publishing the same `[]`, which React bails out of —
  // so this retries when the array actually changes or the bridge reconnects.
  useEffect(() => {
    if (hasConfirmedAgents() || bridgeStatus !== "connected") return;
    void loadAgents((force) => sessions.listAgents(force)).catch(() => {
      /* still unconfirmed; the next snapshot or bridge flip tries again */
    });
  }, [agents, bridgeStatus, sessions]);

  useEffect(() => {
    if (!agents || !hasConfirmedAgents() || !chatId || !boundAgentId) return;
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
    agents,
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
}: {
  chatId: string;
  agentId: string;
  agentName: string;
  cwd: string;
  surfaceActive: boolean;
  preparing: boolean;
}) {
  const dispatch = useWorkspaceDispatch();
  const pendingAutoSend = usePendingAutoSend(chatId);
  const workspaceProvisioning = useWorkspaceProvisioning(cwd);
  const session = useChatSession(
    chatId,
    surfaceActive || preparing || pendingAutoSend,
  );
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

  // Initial spawn (idempotent). ensureSession short-circuits if the
  // same (chatId, agentId) pair is already ready. When the chat has a
  // persisted provider binding (either seeded by "Resume recent thread" or
  // carried over from a previous app run), we ask the provider to resume it
  // instead of creating a new one.
  const sessions = useAgentSessions();
  // Optimistic create: render the provisional composer immediately, but do not
  // spawn into the announced path until the exact create lifecycle publishes.
  // Workbench's longer presentation-only settling window is deliberately not a
  // session gate.
  useEffect(() => {
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
    if (workspaceProvisioning) return;
    let cancelled = false;
    // AWAIT the disk hydrate BEFORE spawning/resuming. loadIntoChat /
    // ensureSession reset the slot with `messages: existing?.messages ?? []`;
    // if hydrate hasn't landed yet that `existing.messages` is [], so a cold
    // open flashed empty (and could lose the optimistic bubble) until hydrate
    // self-healed a frame later. Awaiting it first means the slot already
    // holds the disk transcript when the spawn resets it. (Hydrate is a cheap
    // no-op when the slot already has messages — a live session, a tab swap.)
    // No current adapter replays its transcript on resume, so there's nothing
    // to collide with the hydrate (the old content-suppression was removed).
    void (async () => {
      await session.hydrateChat();
      if (cancelled) return;

      // Provider already has a live session for this chat — nothing to do.
      // Re-read fresh after the await rather than the captured snapshot.
      const existing = sessions.getSession(chatId);
      if (
        existing?.sessionId &&
        existing.status !== "failed" &&
        existing.status !== "reconnecting"
      ) {
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
          })
          .then((adopted) => {
            if (cancelled || adopted) return;
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
        if (!hasPriorContext) {
          void session.ensureSession(agentId, { agentName, cwd, env });
        } else {
          // Probe by Zeros conversation id first. A renderer reload can lose
          // its volatile execution route before a newly-learned provider
          // binding was persisted; the engine can still reattach it. Only a
          // confirmed miss creates a new execution.
          void sessions
            .loadIntoChat(chatId, agentId, null, { agentName, cwd, env })
            .then((adopted) => {
              if (cancelled || adopted) return;
              void session.ensureSession(agentId, { agentName, cwd, env });
            });
        }
      }
      envKeyRef.current = envKey;
    })();
    return () => {
      cancelled = true;
    };
    // We only want this to fire when the identity triple changes, not
    // on every render or when session internals shuffle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chatId,
    agentId,
    cwd,
    surfaceActive,
    preparing,
    pendingAutoSend,
    workspaceProvisioning,
  ]);

  // Persist only the provider binding. The Zeros execution id stays in the
  // live session store and is intentionally absent from durable chat state.
  useEffect(() => {
    if (!chat) return;
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
  }, [chatId, liveProviderBinding, liveProviderMetadata, chat, dispatch]);

  // Respawn when the user changes model/effort — but ONLY for an agent that
  // cannot absorb the change live (see agent/live-config-support.ts).
  //
  // 2026-07-29: this effect used to fire for EVERY agent, and that was a bug
  // with three faces. Claude and Codex already had the change pushed into the
  // running session by agent-chat's pill handlers (setModel / updateConfig),
  // so the respawn was pure duplicate work — and because `force` bypasses the
  // in-flight de-dup in ensureSession, cycling the effort pill N times fired N
  // concurrent AGENT_NEW_SESSION spawns that the engine then had to supersede.
  //
  // Worse, the rebuild is COLD: AGENT_NEW_SESSION carries no prior session id,
  // so Claude minted a fresh claudeSessionId (no `--resume`) and Codex a fresh
  // thread, while the renderer kept the transcript on screen — a
  // mid-conversation model change silently gave the agent amnesia and
  // overwrote the resumable provider binding on the way out. And on a chat
  // with nothing sent yet the warming→ready flip makes the empty-state line
  // blink out and back on every pill click.
  //
  // For the agents that DO need it, the rebuild still runs here. For everyone
  // else the safety net is sendPrompt's settings-drift reconcile
  // (sessions-provider.tsx), which respawns at send time if the live apply
  // never landed — see the appliedChatEnvKey stamp, which is deliberately only
  // written when the agent really applied it.
  useEffect(() => {
    if (!surfaceActive) return;
    if (envKey === envKeyRef.current) return;
    // Bail BEFORE stamping (2026-07-13 fix): stamping first meant a change
    // that landed while `chat` was momentarily null was recorded as applied
    // and permanently swallowed — the session then kept running the old
    // model/effort with no later render able to notice.
    if (!chat) return;
    envKeyRef.current = envKey;
    if (agentAppliesConfigLive(agentId)) return;
    void session.ensureSession(agentId, {
      agentName,
      // Pass cwd verbatim so the
      // gateway can surface "no project folder bound" as an explicit
      // error instead of silently falling back to engine projectRoot.
      // The prior `cwd || undefined` collapse hid the bug.
      cwd,
      env: envForChat(chat, session.initialize),
      force: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envKey, surfaceActive]);

  // Auto-retry on bridge reconnect. The chat lands in `failed` state
  // when its initial load hits a transient bridge error (queue full
  // mid-respawn, AGENT_LOAD_SESSION timeout while the engine is
  // restarting). Without this effect the user has to manually click
  // away and back to retry — a real "stuck" feeling. We only retry
  // once per reconnect: on the rising edge of bridgeStatus going to
  // "connected" while the session is in a failed/transient state.
  const bridgeStatus = useBridgeStatus();
  const lastBridgeStatusRef = useRef(bridgeStatus);
  useEffect(() => {
    const prev = lastBridgeStatusRef.current;
    lastBridgeStatusRef.current = bridgeStatus;
    if (!surfaceActive && !pendingAutoSend) return;
    if (prev === "connected" || bridgeStatus !== "connected") return;
    if (!chat) return;
    if (session.status !== "failed" && session.status !== "reconnecting")
      return;
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
        // Pass cwd verbatim so the
        // gateway can surface "no project folder bound" as an explicit
        // error instead of silently falling back to engine projectRoot.
        // The prior `cwd || undefined` collapse hid the bug.
        cwd,
        env,
      });
    } else {
      void sessions
        .loadIntoChat(chatId, agentId, null, { agentName, cwd, env })
        .then((adopted) => {
          if (adopted) return;
          void session.ensureSession(agentId, { agentName, cwd, env });
        });
    }
    // We deliberately exclude `session` from deps — its identity
    // changes on every state update and would re-fire this loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bridgeStatus,
    chatId,
    agentId,
    agentName,
    cwd,
    pendingAutoSend,
    surfaceActive,
  ]);

  return (
    <AgentChat
      session={session}
      onBack={() => session.reset()}
      headerActions={<></>}
      chatId={chatId}
      surfaceActive={surfaceActive}
      workspaceProvisioning={workspaceProvisioning}
    />
  );
}
