// ──────────────────────────────────────────────────────────
// Chat unread — an agent that finished while nobody was looking
// ──────────────────────────────────────────────────────────
//
// A chat turns unread when its agent finishes (the tab's activity goes from
// working to done without a Stop; a turn parked on the user hasn't finished)
// while the chat isn't on screen: the user is in another workspace, on
// another chat tab, or away from the workspace page. Bringing the chat on
// screen reads it. Chat tabs show a dot in place of the agent's logo;
// workspace rows show it where their plan/question mark sits.
//
// Unread belongs to each chat (its id). It is persisted so a relaunch keeps
// it, bounded to the most recent chats, validated on read, and dropped when
// the chat's tab closes. The chat deck publishes which chats are on screen.
// ──────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";

import { getSetting, setSetting } from "../../platform/settings";
import { useWorkspaceStore } from "../../state/workspace-store";
import { chatAgentActivity } from "./agent-activity";
import { useSessionsStore } from "./sessions-store";
import type { AgentSessionState } from "./use-agent-session";

const KEY = "chat-unread-v1";
export const CHAT_UNREAD_LIMIT = 256;
const MAX_ID_LENGTH = 512;
const EMPTY: ReadonlySet<string> = new Set();

const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> | null = null;
let inView: ReadonlySet<string> = EMPTY;

const validId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH;

function read(): ReadonlySet<string> {
  const stored = getSetting<unknown>(KEY, []);
  if (!Array.isArray(stored)) return EMPTY;
  const ids = stored.filter(validId);
  return ids.length === 0 ? EMPTY : new Set(ids.slice(-CHAT_UNREAD_LIMIT));
}

function current(): ReadonlySet<string> {
  snapshot ??= read();
  return snapshot;
}

function write(next: string[]): void {
  const bounded = next.slice(-CHAT_UNREAD_LIMIT);
  snapshot = bounded.length === 0 ? EMPTY : new Set(bounded);
  setSetting(KEY, bounded);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function chatUnread(chatId: string): boolean {
  return current().has(chatId);
}

/** The chats on screen right now. They read at once, and a chat that finishes
 *  while on screen never turns unread. */
export function setChatsInView(chatIds: readonly string[]): void {
  inView = chatIds.length === 0 ? EMPTY : new Set(chatIds);
  const unread = current();
  if (chatIds.some((id) => unread.has(id))) {
    write([...unread].filter((id) => !inView.has(id)));
  }
}

/** Chats whose agent just finished: each one not on screen turns unread. */
export function noteChatsFinished(chatIds: readonly string[]): void {
  const fresh = new Set(chatIds.filter((id) => validId(id) && !inView.has(id)));
  if (fresh.size === 0) return;
  // Re-appended, so the most recent finishes survive the bound.
  write([...[...current()].filter((id) => !fresh.has(id)), ...fresh]);
}

/** Owner removal: a closed chat tab forgets its unread. */
export function forgetChatUnread(chatIds: readonly string[]): void {
  const unread = current();
  if (!chatIds.some((id) => unread.has(id))) return;
  const drop = new Set(chatIds);
  write([...unread].filter((id) => !drop.has(id)));
}

interface SessionsSnapshot {
  sessions: Record<string, AgentSessionState>;
  pendingLocalTurns: Record<string, string>;
  cancellingChats: ReadonlySet<string>;
}

/** Chats whose agent went from working to done between two store states,
 *  other than by a Stop. Uses the chat tab's own activity, so a Claude turn
 *  still waiting on its background tasks hasn't finished, and neither has a
 *  turn parked on the user. A closed session isn't a finish. */
export function finishedChats(
  prev: SessionsSnapshot,
  next: SessionsSnapshot,
): string[] {
  const finished: string[] = [];
  const candidates = new Set([
    ...Object.keys(prev.sessions),
    ...Object.keys(prev.pendingLocalTurns),
  ]);
  for (const id of candidates) {
    const after = next.sessions[id];
    if (!after) continue;
    const before = prev.sessions[id];
    if (
      before === after &&
      prev.pendingLocalTurns[id] === next.pendingLocalTurns[id]
    )
      continue;
    if (chatAgentActivity(before, prev.pendingLocalTurns[id]) === null) continue;
    if (chatAgentActivity(after, next.pendingLocalTurns[id]) !== null) continue;
    if (
      after.lastStopReason === "cancelled" ||
      prev.cancellingChats.has(id) ||
      next.cancellingChats.has(id)
    )
      continue;
    finished.push(id);
  }
  return finished;
}

/** Chats whose tab just closed (archived). A chat that merely drops out of
 *  the list, as it can while chats reload, keeps its unread until the bound
 *  evicts it. */
export function closedChats(
  prev: ReadonlyArray<{ id: string; archived?: boolean }>,
  next: ReadonlyArray<{ id: string; archived?: boolean }>,
): string[] {
  const open = new Set(prev.filter((chat) => !chat.archived).map((chat) => chat.id));
  return next
    .filter((chat) => chat.archived && open.has(chat.id))
    .map((chat) => chat.id);
}

/** Watch agent turns and chat tabs for the whole app session. */
export function startChatUnreadTracking(): () => void {
  const stopSessions = useSessionsStore.subscribe((state, prev) => {
    const finished = finishedChats(prev, state);
    if (finished.length > 0) noteChatsFinished(finished);
  });
  const stopChats = useWorkspaceStore.subscribe((state, prev) => {
    if (state.chats === prev.chats) return;
    const closed = closedChats(prev.chats, state.chats);
    if (closed.length > 0) forgetChatUnread(closed);
  });
  return () => {
    stopSessions();
    stopChats();
  };
}

/** Whether one chat is unread. A primitive, so tabs re-render only when it
 *  flips. */
export function useChatUnread(chatId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !!chatId && current().has(chatId),
    () => false,
  );
}

/** Whether any of a workspace's chats is unread. */
export function useAnyChatUnread(chatIds: readonly string[]): boolean {
  return useSyncExternalStore(
    subscribe,
    () => chatIds.some((id) => current().has(id)),
    () => false,
  );
}

/** Test-only reset for the module state. */
export function resetChatUnreadForTests(): void {
  snapshot = null;
  inView = EMPTY;
  listeners.clear();
}
