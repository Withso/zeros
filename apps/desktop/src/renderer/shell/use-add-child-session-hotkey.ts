// ⌥⌘T → Add child session of the active Local chat.

import { useEffect } from "react";

import { addChildSession } from "../features/agent/add-child-session";
import { useWorkspaceDispatch, useWorkspaceStore } from "../state/store";

/** `code`, not `key`: Option rewrites the character on macOS. */
export function isAddChildSessionShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">,
): boolean {
  return event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey && event.code === "KeyT";
}

export function useAddChildSessionHotkey(enabled: boolean): void {
  const dispatch = useWorkspaceDispatch();
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isAddChildSessionShortcut(event)) return;
      const { activeChatId, chats } = useWorkspaceStore.getState();
      const parent = chats.find((chat) => chat.id === activeChatId);
      if (!parent) return;
      event.preventDefault();
      addChildSession(parent, { publishChat: (chat) => dispatch({ type: "ADD_CHAT", chat }) });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dispatch, enabled]);
}
