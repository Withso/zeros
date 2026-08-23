import type { ChatThread } from "../../state/store";
import { newChatId } from "../../state/chat-id";

import {
  transcriptFileName,
  transcriptSourceKey,
} from "./chat-transcript-attach";
import type { LiveTextAttachmentInput } from "./composer-text-attachment-delivery";

/** Build a fresh Zeros conversation carrying only user-owned product settings.
 * Provider binding, live execution identity, title/pin/archive state, messages,
 * and drafts intentionally do not cross the boundary. */
export function createForkedChat(
  source: ChatThread,
  id = newChatId(),
  now = Date.now(),
): ChatThread {
  return {
    id,
    folder: source.folder,
    ...(source.kind ? { kind: source.kind } : {}),
    agentId: source.agentId,
    agentName: source.agentName,
    model: source.model,
    effort: source.effort,
    ...(source.fast ? { fast: true } : {}),
    ...(source.additionalDirectories?.length
      ? { additionalDirectories: [...source.additionalDirectories] }
      : {}),
    permissionMode: source.permissionMode,
    ...(source.lastModeId ? { lastModeId: source.lastModeId } : {}),
    ...(source.prePlanModeId ? { prePlanModeId: source.prePlanModeId } : {}),
    title: "Untitled",
    createdAt: now,
    updatedAt: now,
    sourceChatId: source.id,
  };
}

export function buildForkTranscriptAttachment(input: {
  sourceChatId: string;
  sourceLabel: string;
  text: string;
  complete?: boolean;
}): LiveTextAttachmentInput {
  const text =
    input.complete === false
      ? `${input.text.trimEnd()}\n\n> Earlier messages were omitted because the source conversation exceeded the transcript read limit.\n`
      : input.text;
  return {
    sourceKey: transcriptSourceKey(input.sourceChatId),
    name: transcriptFileName(input.sourceLabel, "concise"),
    text,
  };
}
