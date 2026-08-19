// ──────────────────────────────────────────────────────────
// sessions-hooks — chat-scoped + app-level hooks over the actions context
// ──────────────────────────────────────────────────────────
//
// Track 5.C — extracted from sessions-provider.tsx so Vite Fast Refresh
// stops doing a full reload on every edit. This file exports only
// hooks; the provider file exports only the component; the shared
// Context lives in `./sessions-context`.
//
// `useChatSession(chatId)` is the primary surface for chat views —
// returns the chat's slot state PLUS bridge-connected actions bound
// to that chat id. Subscribes via Zustand selector so chat A's stream
// doesn't re-render chat B.
//
// `useAgentSessions()` returns the bare actions context for app-level
// flows (settings panels, sidebar) that aren't tied to a single chat.
// Identity stable across mutations — safe to put in useEffect deps.
// ──────────────────────────────────────────────────────────

import { useCallback, useContext, useSyncExternalStore } from "react";

import type {
  AgentSessionControls,
  AgentSessionState,
} from "./use-agent-session";
import { useSessionsStore, BLANK } from "./sessions-store";
import {
  ActionsCtx,
  type QueuedEditPayload,
  type SessionsCtx,
  type StartForChatOptions,
} from "./sessions-context";

/** Returns chat slot state + bridge-connected actions bound to `chatId`.
 *
 *  Subscribes to `sessions[chatId]` via a Zustand selector so this hook
 *  only re-renders when *this chat's* slot changes — not when sibling
 *  chats stream tokens. Exposes `ensureSession` for chat-view warmup. */
export function useChatSession(
  chatId: string,
  liveUpdates = true,
): AgentSessionState &
  AgentSessionControls & {
    ensureSession(
      agentId: string,
      options?: StartForChatOptions,
    ): Promise<void>;
    hydrateChat(): Promise<void>;
  } {
  const ctx = useContext(ActionsCtx);
  if (!ctx) {
    throw new Error(
      "useChatSession must be used inside <AgentSessionsProvider>",
    );
  }
  // Retained off-screen transcripts keep their DOM but do not need to rebuild
  // it for every token. With notifications parked, their last committed tree
  // stays untouched; the prop change that reveals the chat reads the newest
  // complete slot synchronously in that same render. The default preserves the
  // ordinary live subscription contract for any future non-retained caller.
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!liveUpdates) return () => {};
      return useSessionsStore.subscribe((state, previous) => {
        if (
          (state.sessions[chatId] ?? BLANK) !==
          (previous.sessions[chatId] ?? BLANK)
        ) {
          notify();
        }
      });
    },
    [chatId, liveUpdates],
  );
  const getSnapshot = useCallback(
    () => useSessionsStore.getState().sessions[chatId] ?? BLANK,
    [chatId],
  );
  const slot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const stopBackgroundTask = useCallback(
    (taskId: string) => ctx.stopBackgroundTask(chatId, taskId),
    [chatId, ctx],
  );

  return {
    ...slot,
    listAgents: ctx.listAgents,
    initAgent: ctx.initAgent,
    // startSession kept for API compatibility; forwards to ensureSession
    // with the chat's id baked in.
    startSession: (agentId, options) =>
      ctx.ensureSession(chatId, agentId, options),
    sendPrompt: (text, displayText, attachments, bubbleAttachments, segments) =>
      ctx.sendPrompt(
        chatId,
        text,
        displayText,
        attachments,
        bubbleAttachments,
        segments,
      ),
    cancel: () => ctx.cancel(chatId),
    stopBackgroundTask,
    openBoundaryPort: (portId: string) =>
      ctx.openBoundaryPort(chatId, portId),
    respondToPermission: (response) =>
      ctx.respondToPermission(chatId, response),
    respondToQuestion: (response) => ctx.respondToQuestion(chatId, response),
    setMode: (modeId: string) => ctx.setMode(chatId, modeId),
    setModel: (model: string) => ctx.setModel(chatId, model),
    compactContext: () => ctx.compactContext(chatId),
    updateConfig: () => ctx.updateConfig(chatId),
    removeQueued: (messageId: string) => ctx.removeQueued(chatId, messageId),
    editQueued: (messageId: string, payload: QueuedEditPayload) =>
      ctx.editQueued(chatId, messageId, payload),
    steerQueued: (messageId: string) => ctx.steerQueued(chatId, messageId),
    holdQueue: () => ctx.holdQueue(chatId),
    releaseQueue: () => ctx.releaseQueue(chatId),
    reset: () => ctx.reset(chatId),
    ensureSession: (agentId, options) =>
      ctx.ensureSession(chatId, agentId, options),
    hydrateChat: () => ctx.hydrateChat(chatId),
  };
}

/** App-level access for flows that aren't tied to a single chat
 *  (e.g. the settings Agents panel fetching the registry).
 *
 *  Returns the **stable** actions context. Its identity does NOT change
 *  on every store mutation — that's the whole point. Consumers can put
 *  this in `useEffect`/`useCallback` deps without their effects
 *  re-firing on every chat token (the bug that produced the 50+/sec
 *  AGENT_INIT_AGENT flood).
 *
 *  For chat-slot data: use `useChatSession(chatId)` (sliced).
 *  For warm-agent state: read `warmAgentIds` from the sessions store. */
export function useAgentSessions(): SessionsCtx {
  const ctx = useContext(ActionsCtx);
  if (!ctx) {
    throw new Error(
      "useAgentSessions must be used inside <AgentSessionsProvider>",
    );
  }
  return ctx;
}
