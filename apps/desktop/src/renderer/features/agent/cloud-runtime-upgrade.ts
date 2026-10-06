import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { classifyCloudAdmissionFailure, cloudAdmissionFailureCode } from "./cloud-admission-failure";
import { useWorkspaceStore, type ComposerDraft } from "../../state/store";
import { tryRestoreLiveChatDraft } from "./composer-live-drafts";
import { messageToEditorContent } from "./composer-editor/reconstruct";
import type { SessionsStoreState } from "./sessions-store";
import type { AgentTextMessage } from "./use-agent-session";
import { reportCloudAgentRuntimeUpgrade, invalidateCloudAgentRegistry } from "./workspace-agent-registry";

/** This closed code proves admission refused before provider execution. Return
 * the draft and hold queued successors; neither reconnect nor refresh resends. */
export function recoverCloudAdmissionFailure(input: {
  folder: string | null | undefined;
  chatId: string;
  error: unknown;
  message: AgentTextMessage;
  model?: string | null;
  draft?: ComposerDraft | null;
  store: Pick<SessionsStoreState, "sessions" | "patchSession">;
  pauseQueue: (chatId: string) => void;
  persist?: (chatId: string, message: AgentTextMessage) => void;
}): boolean {
  if (!isCloudWorkspace(input.folder)) return false;
  const { chatId, message, store } = input, slot = store.sessions[chatId];
  const model = input.model === undefined ? useWorkspaceStore.getState().chats.find(chat => chat.id === chatId)?.model ?? null : input.model;
  const failure = classifyCloudAdmissionFailure({ folder: input.folder, error: input.error, model, agentId: slot?.agentId });
  // The preparation queue owns wake waits and its editable FIFO. Do not restore or
  // resend a waiting entry as a rejected admission.
  if (!failure || failure.kind === "waiting") return false;
  if (!slot?.agentId) return true;
  const code = String(cloudAdmissionFailureCode(input.error));
  input.pauseQueue(chatId);
  if (failure.kind === "runtime-upgrade-required") reportCloudAgentRuntimeUpgrade(input.folder!, slot.agentId);
  else invalidateCloudAgentRegistry(input.folder!);
  const cloudAdmissionFailure = { ...failure, code, turnId: message.id, agentId: slot.agentId, model };
  if (failure.kind === "unavailable") {
    // A generic dispatch failure can occur after a quiet provider has started.
    // Retain the entire transcript and require review; never invent a refusal.
    store.patchSession(chatId, { status: "ready", error: null, failure: null, activeTurnStartedAt: null, cloudAdmissionFailure });
    return true;
  }
  const saved: AgentTextMessage = { ...message, queued: false, queuedPresentation: undefined, queuedEditable: undefined,
    recoveryFailure: { kind: "cloud-admission", message: code } };
  const workspace = useWorkspaceStore.getState(), existing = workspace.chatComposerDrafts[chatId];
  if (workspace.chats.some(chat => chat.id === chatId)) input.persist?.(chatId, saved);
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
    status: "ready", error: null, failure: null, lastStopReason: null, activeTurnStartedAt: null,
    cloudAdmissionFailure,
    // Newer typing wins. If restoration was declined, retain the rejected
    // prompt in the transcript so the user can copy/edit it after the wake.
    messages: restored ? slot.messages.filter(row => row.id !== message.id) : slot.messages.map(row => row.id === message.id ? saved : row),
  });
  return true;
}

/** Compatibility entry point used by runtime-only recovery callers. */
export function recoverCloudRuntimeUpgrade(input: Parameters<typeof recoverCloudAdmissionFailure>[0]): boolean {
  return cloudAdmissionFailureCode(input.error) === "cloud_runtime_upgrade_required" && recoverCloudAdmissionFailure(input);
}
