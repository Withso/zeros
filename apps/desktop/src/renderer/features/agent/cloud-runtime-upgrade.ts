import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { useWorkspaceStore, type ComposerDraft } from "../../state/store";
import { tryRestoreLiveChatDraft } from "./composer-live-drafts";
import { messageToEditorContent } from "./composer-editor/reconstruct";
import type { SessionsStoreState } from "./sessions-store";
import type { AgentTextMessage } from "./use-agent-session";
import { reportCloudAgentRuntimeUpgrade } from "./workspace-agent-registry";

/** This closed code proves admission refused before provider execution. Return
 * the draft and hold queued successors; neither reconnect nor refresh resends. */
export function recoverCloudRuntimeUpgrade(input: {
  folder: string | null | undefined;
  chatId: string;
  error: unknown;
  message: AgentTextMessage;
  draft?: ComposerDraft | null;
  store: Pick<SessionsStoreState, "sessions" | "patchSession">;
  pauseQueue: (chatId: string) => void;
}): boolean {
  if (!isCloudWorkspace(input.folder)) return false;
  const code = input.error instanceof Error ? input.error.message : input.error;
  if (code !== "cloud_runtime_upgrade_required") return false;
  const { chatId, message, store } = input, slot = store.sessions[chatId];
  if (!slot?.agentId) return true;
  input.pauseQueue(chatId);
  reportCloudAgentRuntimeUpgrade(input.folder!, slot.agentId);
  const workspace = useWorkspaceStore.getState(), existing = workspace.chatComposerDrafts[chatId];
  let restored = false;
  if (workspace.chats.some(chat => chat.id === chatId) &&
      (!existing || (!existing.text.trim() && !existing.attachments.length))) {
    // A warming/queued send no longer has a live draft; its bubble retains
    // mention segments and attachment references for normal composer recovery.
    const draft = input.draft?.text.trim() === message.text.trim() ? input.draft : {
      text: message.text, ...messageToEditorContent(message),
    };
    if (tryRestoreLiveChatDraft(chatId, draft)) {
      workspace.dispatch({ type: "SET_CHAT_DRAFT", chatId, draft });
      restored = true;
    }
  }
  store.patchSession(chatId, {
    status: "ready", error: null, failure: null, activeTurnStartedAt: null,
    // Newer typing wins. If restoration was declined, retain the rejected
    // prompt in the transcript so the user can copy/edit it after the wake.
    messages: restored ? slot.messages.filter(row => row.id !== message.id) : slot.messages,
  });
  return true;
}
