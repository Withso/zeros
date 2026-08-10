import { deleteChat, getChat, upsertChat } from "../db/chats";
import type { NativeThreadEvent } from "./types";

export type NativeThreadProjection =
  | "updated"
  | "deleted"
  | "closed"
  | "ignored";

/** Apply an external provider lifecycle event to the exact bound chat. The
 * native id check is load-bearing: one Codex runtime can report child threads,
 * and stale notifications must never mutate a different Zeros chat. */
export function projectNativeThreadEvent(
  chatId: string,
  event: NativeThreadEvent,
): NativeThreadProjection {
  const chat = getChat(chatId);
  const persistedNativeId = chat?.nativeSessionId ?? chat?.sessionId;
  if (
    !chat ||
    chat.agentId !== "codex" ||
    chat.sessionId !== event.sessionId ||
    persistedNativeId !== event.nativeThreadId
  ) {
    return "ignored";
  }

  if (event.event === "closed") return "closed";
  if (event.event === "deleted") {
    deleteChat(chatId);
    return "deleted";
  }

  const nextArchived =
    event.event === "archived"
      ? true
      : event.event === "unarchived"
        ? false
        : chat.archived;
  const nextTitle =
    event.event === "name-updated" ? event.name?.trim() : chat.title;
  if (!nextTitle) return "ignored";
  if (nextArchived === chat.archived && nextTitle === chat.title) {
    return "ignored";
  }

  upsertChat({
    ...chat,
    archived: nextArchived,
    title: nextTitle,
    updatedAt: Math.max(Date.now(), chat.updatedAt + 1),
  });
  return "updated";
}
