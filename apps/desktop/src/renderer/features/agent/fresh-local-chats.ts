import { getSetting, setSetting } from "../../platform/settings";
import { isLocalTranscriptChat } from "../../state/local-transcript-cache";

// Chats minted by THIS renderer (a new tab, a workspace's first chat, /clear,
// a fork destination) cannot have transcript rows yet: the engine persists a
// row only after the first prompt. Their first open therefore needs no window
// read and never shows "Loading conversation…". Dependency-free so the
// workspace store can record creations without importing the sessions store.

const MAX_FRESH_CHATS = 64;
const freshChats = new Set<string>();

/** Record a Local chat this renderer just created. Bounded; consumed once. */
export function markFreshLocalChat(chatId: string, folder: string | null | undefined): void {
  if (!folder || !isLocalTranscriptChat(chatId, folder)) return;
  freshChats.delete(chatId);
  freshChats.add(chatId);
  while (freshChats.size > MAX_FRESH_CHATS) freshChats.delete(freshChats.values().next().value!);
  rememberEmptyLocalChat(chatId, folder);
}

/** True exactly once for a chat recorded by markFreshLocalChat. */
export function consumeFreshLocalChat(chatId: string): boolean {
  return freshChats.delete(chatId);
}

/** Deleted or reset: neither mark may outlive the chat's old state. */
export function forgetFreshLocalChat(chatId: string): void {
  freshChats.delete(chatId);
  forgetEmptyLocalChat(chatId);
}

// Known-empty Local chats: minted here, or confirmed empty by the engine, and
// with no message or history hint seen since. Persisted (ids only, bounded)
// so after a restart such a chat paints its empty state while the engine
// starts instead of "Loading conversation…". That paint is provisional; the
// engine still confirms it. Any history hint removes the id synchronously.

const EMPTY_CHATS_KEY = "local-empty-chats-v1";
const MAX_EMPTY_CHATS = 128;
let emptyChats: Set<string> | null = null;

function knownEmptyChats(): Set<string> {
  if (!emptyChats) {
    const saved = getSetting<unknown>(EMPTY_CHATS_KEY, []);
    const ids = Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    emptyChats = new Set(ids.slice(-MAX_EMPTY_CHATS));
  }
  return emptyChats;
}

function saveKnownEmptyChats(): void {
  setSetting(EMPTY_CHATS_KEY, [...knownEmptyChats()]);
}

export function rememberEmptyLocalChat(chatId: string, folder: string | null | undefined): void {
  if (!folder || !isLocalTranscriptChat(chatId, folder)) return;
  const chats = knownEmptyChats();
  if (chats.has(chatId)) return;
  chats.add(chatId);
  while (chats.size > MAX_EMPTY_CHATS) chats.delete(chats.values().next().value!);
  saveKnownEmptyChats();
}

export function forgetEmptyLocalChat(chatId: string): void {
  if (knownEmptyChats().delete(chatId)) saveKnownEmptyChats();
}

export function isKnownEmptyLocalChat(chatId: string): boolean {
  return knownEmptyChats().has(chatId);
}

/** Prune to the confirmed chat list (deleted chats, removed repositories). */
export function retainKnownEmptyLocalChats(keep: (chatId: string) => boolean): void {
  const chats = knownEmptyChats();
  let changed = false;
  for (const chatId of [...chats]) {
    if (keep(chatId)) continue;
    chats.delete(chatId);
    changed = true;
  }
  if (changed) saveKnownEmptyChats();
}
