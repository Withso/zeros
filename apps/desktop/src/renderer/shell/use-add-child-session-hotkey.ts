// ⌥⌘T → Add child session of the active Local chat.

import { useEffect } from "react";

import { addChildSession } from "../features/agent/add-child-session";
import { sessionViewChatId } from "../features/agent/side-chat";
import { useWorkspaceDispatch, useWorkspaceStore, type ChatThread } from "../state/store";

/** `code`, not `key`: Option rewrites the character on macOS. */
export function isAddChildSessionShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">,
): boolean {
  return event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey && event.code === "KeyT";
}

/** The session ⌥⌘T adds a child to: the focused chat, or, while a side chat
 *  has focus, the chat column's own session, as the ⋯ menu does. */
export function childSessionParentFor(chats: readonly ChatThread[], activeChatId: string | null): ChatThread | null {
  const active = chats.find((chat) => chat.id === activeChatId);
  if (!active) return null;
  const id = sessionViewChatId(chats, active.id, active.folder);
  return chats.find((chat) => chat.id === id) ?? null;
}

export function useAddChildSessionHotkey(enabled: boolean): void {
  const dispatch = useWorkspaceDispatch();
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isAddChildSessionShortcut(event)) return;
      const { activeChatId, chats } = useWorkspaceStore.getState();
      const parent = childSessionParentFor(chats, activeChatId);
      if (!parent) return;
      event.preventDefault();
      addChildSession(parent, { publishChat: (chat) => dispatch({ type: "ADD_CHAT", chat }) });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dispatch, enabled]);
}
