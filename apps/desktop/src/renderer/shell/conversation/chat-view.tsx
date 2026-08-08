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

import React, { useEffect, useRef, useState } from "react";
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
import { envForChat } from "../../features/agent/model-catalog";
import { agentAppliesConfigLive } from "../../features/agent/live-config-support";
import { useDefaultAgent } from "../../features/settings/default-agent";
import {
  loadAgents,
  useAgentsSnapshot,
} from "../../features/agent/agents-cache";
import { useEnabledAgents } from "../../features/agent/enabled-agents";
import { ZerosSpinner } from "../../shared/ui/loading";
import { isRemovedAgent } from "../../features/agent/agent-runnable";
import { AgentRemovedPanel } from "../agent-removed-panel";
import { NoFolderPanel } from "../no-folder-panel";
import { useChatCwd } from "../use-chat-cwd";
import { useWorkspaceProvisioning } from "../../state/pending-workspaces";
import { finishPreparedChatView } from "./chat-intent";
import { resolveAutoBindChatSettings } from "./auto-bind-chat";

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

/** Side-effect component: when mounted with a chat that has no agentId,
 *  resolves the default and writes it back to the store. The parent then
 *  re-renders into ChatBody on the very next tick. A spinner renders during
 *  the in-flight binding (one paint against a warm snapshot).
 *
 *  The lookup priority mirrors `pickAgentForNewChat` in default-agent.ts:
 *  explicit default > Codex > Claude > Cursor > first, relaxing from
 *  enabled+runnable down to best-detected so a loaded registry ALWAYS binds —
 *  a machine with nothing signed in gets the composer's "Sign in required"
 *  flow, never a dead pane. Binding waits only for the authoritative registry
 *  and writes the agent, model, effort, Fast, and permission posture in one
 *  update. */
function AutoBindAgent({ chat }: { chat: ChatThread }) {
  const dispatch = useWorkspaceDispatch();
  const { agentId: starredId } = useDefaultAgent();
  const { isEnabled } = useEnabledAgents();
  const agents = useAgentsSnapshot();
  const sessions = useAgentSessions();
  const bridgeStatus = useBridgeStatus();
  // Latch so the settings update triggered below cannot make this effect
  // double-write the chat on its immediate re-render.
  const boundRef = useRef(false);
  // Flips when the registry has taken too long, which downgrades the wait from
  // "block for the authoritative list" to "bind the product default now".
  const [waitedOut, setWaitedOut] = useState(false);

  // The cache's only routine loader lives in AgentChat — which never mounts
  // while this chat is agentless. On a cold cache (fresh install, new dev
  // data dir) nothing else fills the snapshot, so kick the load here or this
  // pane sits unbound forever. Gated on a connected bridge (same idiom as
  // settings-page) so a boot-time blip doesn't convert into a spurious `[]`
  // registry; the status flip re-runs this. loadAgents de-dupes concurrent
  // callers, and its failure path publishes `[]` — which the bind effect
  // below resolves via the product fallback.
  useEffect(() => {
    if (agents !== null || bridgeStatus !== "connected") return;
    void loadAgents((force) => sessions.listAgents(force)).catch(() => {
      /* snapshot flipped to [] and emitted; the bind effect takes over */
    });
  }, [agents, bridgeStatus, sessions]);

  // Hard ceiling on the wait. Every path above assumes the bridge eventually
  // connects and the registry eventually answers; if neither happens — a dead
  // engine on a first run, with no persisted snapshot to fall back on — there
  // is nothing left to re-trigger the effects and the pane would spin forever.
  // Binding the product default instead gives the user a live composer whose
  // spawn error names the real problem. Comfortably longer than the
  // agents-cache 30 s listAgents ceiling so a merely-slow probe still wins.
  useEffect(() => {
    if (agents !== null || boundRef.current) return;
    const timer = setTimeout(() => setWaitedOut(true), 45_000);
    return () => clearTimeout(timer);
  }, [agents]);

  useEffect(() => {
    if (boundRef.current) return;
    const settings = resolveAutoBindChatSettings(
      // An empty list resolves through the same product fallback the
      // registry-answered-with-nothing case uses.
      waitedOut ? (agents ?? []) : agents,
      starredId,
      isEnabled,
      { agentName: chat.agentName, sessionId: chat.sessionId },
    );
    if (!settings) return;
    boundRef.current = true;
    // Several ChatViews are mounted at once in a split workspace. Updating
    // this one chat must not use HYDRATE_CHATS with `activeChatId: chat.id`:
    // an agentless chat in a background pane would steal keyboard/composer
    // focus as soon as its passive effect ran.
    dispatch({
      type: "UPDATE_CHAT_SETTINGS",
      id: chat.id,
      updates: settings,
    });
  }, [
    agents,
    chat.agentName,
    chat.id,
    chat.sessionId,
    dispatch,
    isEnabled,
    starredId,
    waitedOut,
  ]);

  // Registry still hydrating. Show a quiet spinner rather than a dead-blank
  // pane so a slow first probe reads as loading, not broken.
  return (
    <div className="bg-bg1 flex h-full w-full items-center justify-center">
      <ZerosSpinner size={20} />
    </div>
  );
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
  const liveSessionId = useSessionsStore((state) => {
    const slot = state.sessions[chatId];
    return slot?.durableSessionId ?? slot?.sessionId ?? null;
  });
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
  // persisted sessionId (either seeded by "Resume recent thread" or
  // carried over from a previous app run), we load that session from
  // disk instead of creating a new one — provider state is a hot
  // cache, the agent CLI's on-disk transcript is the source of truth.
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
      const persistedSessionId = chat?.sessionId;
      // Pass cwd verbatim so the gateway can surface
      // "no project folder bound" as an explicit error instead of silently
      // falling back to engine projectRoot.
      if (persistedSessionId) {
        // Tell the engine the prior session id so future prompts resume the
        // agent's server-side context. On AGENT_ERROR the provider lands in
        // "failed" — clear sessionId so the next Retry falls into ensureSession
        // with a fresh id.
        void sessions
          .loadIntoChat(chatId, agentId, persistedSessionId, {
            agentName,
            cwd,
            env,
          })
          .then(() => {
            if (cancelled) return;
            const after = sessions.getSession(chatId);
            if (after?.status === "failed") {
              dispatch({
                type: "UPDATE_CHAT_SETTINGS",
                id: chatId,
                updates: { sessionId: undefined },
              });
            }
          });
      } else {
        void session.ensureSession(agentId, { agentName, cwd, env });
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

  // Persist the session id back onto the chat metadata whenever the
  // provider reports a new one (after newSession, loadSession, or a
  // forced model-swap respawn). This is what makes the disk link
  // survive app restarts and future workspace swaps.
  useEffect(() => {
    if (!chat) return;
    const sid = liveSessionId;
    if (sid && sid !== chat.sessionId) {
      dispatch({
        type: "UPDATE_CHAT_SETTINGS",
        id: chatId,
        updates: { sessionId: sid },
      });
    }
  }, [chatId, liveSessionId, chat, dispatch]);

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
  // overwrote the resumable chat.sessionId on the way out. And on a chat with
  // nothing sent yet the warming→ready flip makes the empty-state line blink
  // out and back on every pill click.
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
    const persistedSessionId = chat.sessionId;
    if (persistedSessionId) {
      void sessions.loadIntoChat(chatId, agentId, persistedSessionId, {
        agentName,
        // Pass cwd verbatim so the
        // gateway can surface "no project folder bound" as an explicit
        // error instead of silently falling back to engine projectRoot.
        // The prior `cwd || undefined` collapse hid the bug.
        cwd,
        env,
      });
    } else {
      void session.ensureSession(agentId, {
        agentName,
        // Pass cwd verbatim so the
        // gateway can surface "no project folder bound" as an explicit
        // error instead of silently falling back to engine projectRoot.
        // The prior `cwd || undefined` collapse hid the bug.
        cwd,
        env,
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
