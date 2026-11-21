// Sessions can't be closed any more, so a chat closed with the old tab strip
// (archived) is listed like any other session and reopened when opened.

import { editChat } from "./cloud-chat-edits";
import { useWorkspaceStore, type Action } from "./workspace-store";

export function openSession(dispatch: (action: Action) => void, chatId: string): void {
  const chat = useWorkspaceStore.getState().chats.find((row) => row.id === chatId);
  if (chat?.archived) editChat(dispatch, chatId, { archived: false });
  dispatch({ type: "SET_ACTIVE_CHAT", id: chatId });
}
