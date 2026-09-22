import type { Action, ChatThread } from "../../state/store";
import { newChatId } from "../../state/chat-id";
import type { DispatcherCreatePayload } from "./dispatcher-composer";

/** Publish the selected chat configuration and its destination together. The
 * draft must exist before the chat mounts; AgentChat consumes the send intent
 * once its session is ready. Direct folder chats have no checkout to wait for. */
export function createDispatcherChat({
  dispatch,
  repoRoot,
  folder,
  payload,
  validationPending = false,
}: {
  dispatch: (action: Action) => void;
  repoRoot: string;
  folder: string;
  payload: DispatcherCreatePayload;
  validationPending?: boolean;
}): string {
  const chatId = newChatId();
  const chat: ChatThread = {
    id: chatId,
    folder,
    agentId: payload.selection.agentId,
    agentName: payload.selection.agentName,
    model: payload.selection.model,
    effort: payload.effort,
    permissionMode: payload.permissionMode,
    // Carry the EXACT native mode the user picked so bind restores it
    // losslessly (e.g. Claude "Accept Edits" doesn't collapse to "Auto").
    ...(payload.lastModeId ? { lastModeId: payload.lastModeId } : {}),
    ...(payload.fast ? { fast: true } : {}),
    ...(payload.additionalDirectories.length > 0
      ? { additionalDirectories: payload.additionalDirectories }
      : {}),
    title: "Untitled",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (payload.serialized) {
    dispatch({
      type: "SET_CHAT_DRAFT",
      chatId,
      draft: {
        text: payload.serialized.displayText,
        attachments: payload.serialized.attachments,
        json: payload.serialized.json,
      },
    });
  }
  dispatch({
    type: "ADD_CHAT",
    chat,
    recordWorkspaceActivity: true,
    openWorkspace: {
      repoRoot,
      validationPending,
    },
  });
  if (payload.serialized) {
    dispatch({ type: "REQUEST_AUTO_SEND", chatId });
  }

  return chatId;
}
