// ──────────────────────────────────────────────────────────
// Transcript presentation — paint before the authoritative history answers
// ──────────────────────────────────────────────────────────
//
// Glue between the sessions store and the shared Local/cloud transcript cache
// (state/local-transcript-cache.ts). Everything here is presentation-only:
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

import { cloudWorkspaceKey, isCloudWorkspace, parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import {
  isLocalTranscriptChat,
  localTranscriptCache,
  transcriptCacheFor,
  transcriptMessageSignature,
  type LocalTranscriptWindow,
} from "../../state/local-transcript-cache";
import { BLANK, useSessionsStore } from "./sessions-store";
import { consumeFreshLocalChat, isKnownEmptyLocalChat } from "./fresh-local-chats";
import type { AgentSessionState } from "./use-agent-session";
import type { AgentMessageWindow } from "./agent-history-client";
import { messageSnapshotsEqual } from "./message-persistence-tracker";

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
  if (!isLocalTranscriptChat(chatId, useSessionsStore.getState().sessions[chatId]?.cwd)) return false;
  return presentCachedTranscript(chatId, window);
}

export function presentCachedTranscript(chatId: string, window: LocalTranscriptWindow): boolean {
  if (window.messages.length === 0) return false;
  const store = useSessionsStore.getState();
  const slot = store.sessions[chatId];
  if (slot?.transcriptState === "resident" || !transcriptCacheFor(chatId, slot?.cwd)) return false;
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
    transcriptSource: window.source,
    transcriptContentSignatures: window.contentSignatures,
    ...(parseCloudScopedId(chatId) && !slot?.cwd ? { cwd: cloudWorkspaceKey(parseCloudScopedId(chatId)!) } : {}),
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

export function paintTranscriptFromMemory(chatId: string | undefined, folder: string | null | undefined): boolean {
  if (!chatId) return false;
  if (isLocalTranscriptChat(chatId, folder)) return paintLocalTranscriptFromMemory(chatId, folder);
  const cached = transcriptCacheFor(chatId, folder)?.peek(chatId);
  return !!cached && presentCachedTranscript(chatId, cached);
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
  rememberTranscript(chatId, slot, owner);
}

export function rememberTranscript(chatId: string, slot: AgentSessionState, folder: string | null | undefined): void {
  if (slot.transcriptState !== "resident" || slot.transcriptPresentation) return;
  const cache = transcriptCacheFor(chatId, folder ?? slot.cwd);
  if (!cache) return;
  // The retry journal owns unconfirmed/queued prompts. Never fold them into
  // the confirmed transcript cache or learn authority from their presence.
  const cloud = parseCloudScopedId(chatId);
  if (cloud && (!slot.transcriptSource || slot.cloudPromptPending)) return;
  const messages = cloud ? slot.messages.filter(message => message.kind !== "text" || !message.queued) : slot.messages;
  cache.remember(chatId, folder ?? slot.cwd, {
    messages: messages.length === slot.messages.length ? slot.messages : messages,
    leadingPrompt: slot.leadingPrompt ?? null,
    ...(slot.transcriptSource ? { source: slot.transcriptSource } : {}),
  });
}

/** Without a server revision cursor, a mirror must reach the known worker
 * tail before it can replace it. An identical ID with older content is still
 * lagging; a later native update stamp can prove an edit. No reads or wakes. */
export function canReplaceCloudTranscript(slot: AgentSessionState, page: AgentMessageWindow): boolean {
  if (slot.transcriptSource !== "worker" || page.source === "worker") return true;
  if (page.source !== "control-plane") return false;
  const current = slot.messages.filter(message => message.kind !== "text" || !message.queued);
  const tail = current.at(-1);
  if (!tail) return true;
  const incoming = new Map(page.messages.map(message => [message.id, message]));
  if (page.leadingPrompt) incoming.set(page.leadingPrompt.id, page.leadingPrompt);
  if (!incoming.has(tail.id)) return false;
  return [...(slot.leadingPrompt ? [slot.leadingPrompt] : []), ...current].every(message => {
    const next = incoming.get(message.id);
    if (!next) return true; // A complete window may have deleted an older row.
    if (messageSnapshotsEqual([message], [next])) return true;
    const signature = slot.transcriptContentSignatures?.[message.id];
    if (signature && signature === transcriptMessageSignature(next)) return true;
    // An opening published before Git capture (or by an older worker) has no
    // update stamp yet. Its creation time is the baseline for the first saved
    // summary; an unstamped or older mirror still cannot replace live content.
    const updatedAt = "updatedAt" in message && typeof message.updatedAt === "number" ? message.updatedAt : message.createdAt;
    return "updatedAt" in next && typeof next.updatedAt === "number" && next.updatedAt > updatedAt;
  });
}
