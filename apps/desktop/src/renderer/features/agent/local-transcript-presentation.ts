// ──────────────────────────────────────────────────────────
// Local transcript presentation — paint before the engine answers
// ──────────────────────────────────────────────────────────
//
// Glue between the sessions store and the Local transcript cache
// (state/local-transcript-cache.ts). Everything here is Local-only and
// presentation-only:
//
//   • a chat minted by this renderer is known to be empty, so it starts
//     resident instead of waiting on a read (no "Loading conversation…" for a
//     new tab);
//   • a cold Local chat paints its last confirmed window as a provisional
//     `transcriptPresentation` while the authoritative engine window loads.
//     Provisional rows are read-only and never authorize a send, queue drain,
//     edit or completion; the engine window replaces them;
//   • a cold Local chat known to be empty paints its empty state the same
//     provisional way (`empty: true`), e.g. after a restart.
// ──────────────────────────────────────────────────────────

import { isCloudWorkspace, parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import {
  isLocalTranscriptChat,
  localTranscriptCache,
  type LocalTranscriptWindow,
} from "../../state/local-transcript-cache";
import { BLANK, useSessionsStore } from "./sessions-store";
import { consumeFreshLocalChat, isKnownEmptyLocalChat } from "./fresh-local-chats";
import type { AgentSessionState } from "./use-agent-session";

export { forgetFreshLocalChat, markFreshLocalChat } from "./fresh-local-chats";

/** True once for a chat this renderer created that has never had a session
 * slot: its transcript is known to be empty. */
export function takeFreshLocalChat(chatId: string): boolean {
  return consumeFreshLocalChat(chatId) && !useSessionsStore.getState().sessions[chatId];
}

/** Install a cached Local window as provisional presentation. Durable rows
 * already on screen and resident slots always win; queued placeholders stay
 * owned by the send path and remain after the cached rows. */
export function presentCachedLocalTranscript(
  chatId: string,
  window: LocalTranscriptWindow,
): boolean {
  if (window.messages.length === 0) return false;
  const store = useSessionsStore.getState();
  const slot = store.sessions[chatId];
  if (slot && (slot.transcriptState === "resident" || isCloudWorkspace(slot.cwd))) return false;
  if (parseCloudScopedId(chatId)) return false;
  if (slot?.transcriptPresentation && slot.messages[0] === window.messages[0] &&
      slot.messages.length >= window.messages.length) return true;
  const current = slot?.messages ?? [];
  if (current.some((message) => message.kind !== "text" || !message.queued)) return false;
  const known = new Set(window.messages.map((message) => message.id));
  const queued = current.filter((message) => !known.has(message.id));
  const patch: Partial<AgentSessionState> = {
    messages: queued.length > 0 ? [...window.messages, ...queued] : window.messages,
    leadingPrompt: window.leadingPrompt,
    transcriptState: "loading",
    transcriptPresentation: { source: "cache" },
    // A live update may have marked this exact read stale; keep that so the
    // authoritative publish still re-windows once.
    transcriptDirty: slot?.transcriptDirty ?? false,
    hasTranscript: true,
  };
  if (slot) store.patchSession(chatId, patch);
  else store.setSession(chatId, { ...BLANK, ...patch });
  return true;
}

/** A Local chat known to be empty (see fresh-local-chats.ts) paints its
 * empty state while the engine confirms it. Never over durable rows, a
 * history hint or a resident slot. */
export function presentKnownEmptyLocalTranscript(chatId: string): boolean {
  if (parseCloudScopedId(chatId) || !isKnownEmptyLocalChat(chatId)) return false;
  const store = useSessionsStore.getState();
  const slot = store.sessions[chatId];
  if (slot && (slot.transcriptState === "resident" || isCloudWorkspace(slot.cwd) ||
      slot.hasTranscript || slot.messages.length > 0)) return false;
  if (slot?.transcriptPresentation?.empty) return true;
  const patch: Partial<AgentSessionState> = {
    transcriptState: "loading",
    transcriptPresentation: { source: "cache", empty: true },
    transcriptDirty: slot?.transcriptDirty ?? false,
  };
  if (slot) store.patchSession(chatId, patch);
  else store.setSession(chatId, { ...BLANK, ...patch });
  return true;
}

/** Same-frame paint from memory, for a chat view becoming visible. A missing
 * slot already renders empty; its hydrate decides. */
export function paintLocalTranscriptFromMemory(
  chatId: string | undefined,
  folder: string | null | undefined,
): boolean {
  if (!chatId || !isLocalTranscriptChat(chatId, folder)) return false;
  const slot = useSessionsStore.getState().sessions[chatId];
  if (slot?.transcriptState === "resident") return false;
  const cached = localTranscriptCache.peek(chatId);
  if (cached) return presentCachedLocalTranscript(chatId, cached);
  return !!slot && presentKnownEmptyLocalTranscript(chatId);
}

/** Remember a resident Local slot's confirmed window. */
export function rememberLocalTranscript(
  chatId: string,
  slot: AgentSessionState,
  folder: string | null | undefined,
): void {
  if (slot.transcriptState !== "resident" || slot.transcriptPresentation) return;
  const owner = folder ?? slot.cwd;
  if (!isLocalTranscriptChat(chatId, owner)) return;
  localTranscriptCache.remember(chatId, owner, {
    messages: slot.messages,
    leadingPrompt: slot.leadingPrompt ?? null,
  });
}
