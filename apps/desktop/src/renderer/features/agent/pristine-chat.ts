import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import type { ChatThread } from "../../state/store";
import type { AgentSessionState } from "./use-agent-session";

type Chat = Pick<ChatThread, "folder" | "title" | "sessionId" | "providerBinding">;
type Slot = Pick<AgentSessionState, "transcriptState" | "hasTranscript" | "messages" | "providerBinding" |
  "foregroundTurnId" | "activeTurnStartedAt" | "cloudPromptPending" | "cloudStop" | "cloudOutbox">;

export function hasUntitledChatName(chat: Pick<Chat, "folder" | "title">): boolean {
  // The worker can create metadata before the desktop's initial upsert. Its
  // empty title is displayed as Untitled; it is not evidence of a first Send.
  return chat.title === "Untitled" || isCloudWorkspace(chat.folder) && chat.title === "";
}

/** Local keeps its existing title/history test. Cloud additionally honors the
 * worker's durable first-turn binding and any pending Send/Stop ownership. */
export function canSwitchPristineChat(chat: Chat | null | undefined, slot: Slot | undefined): boolean {
  if (!chat || !hasUntitledChatName(chat) || (slot?.transcriptState ?? "resident") !== "resident" ||
      slot?.hasTranscript || (slot?.messages.length ?? 0) !== 0) return false;
  return !isCloudWorkspace(chat.folder) || !chat.providerBinding && !chat.sessionId && !slot?.providerBinding &&
    !slot?.foregroundTurnId && slot?.activeTurnStartedAt == null && !slot?.cloudPromptPending && !slot?.cloudStop && !slot?.cloudOutbox?.rows.length;
}
