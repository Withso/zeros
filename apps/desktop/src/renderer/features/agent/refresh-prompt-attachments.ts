import type { ContentBlock } from "../../platform/bridge/agent-events";
import type {
  AgentTextMessageAttachment,
  MessageContentSegment,
} from "@zeros/protocol/agent-messages";
import {
  encodeAttachments,
  type EncodeAttachmentsContext,
} from "./encode-attachments";
import { messageToEditorContent } from "./composer-editor/reconstruct";

export interface PromptAttachments {
  attachments?: ContentBlock[];
  bubbleAttachments?: AgentTextMessageAttachment[];
  segments?: MessageContentSegment[];
}

export function hasPromptAttachmentReferences(
  payload: PromptAttachments,
): boolean {
  return (
    payload.bubbleAttachments?.some((a) => a.delivery === "reference") === true
  );
}

/** Queued payloads contain confirmed paths from enqueue time. Re-resolve their
 * stable records at dispatch and update both the wire blocks and visible chips.
 * Other context blocks remain in place. Never send a partial attachment set. */
export async function refreshPromptAttachments(
  payload: PromptAttachments,
  context: EncodeAttachmentsContext,
): Promise<PromptAttachments> {
  const originals = payload.bubbleAttachments ?? [];
  const references = originals.filter((a) => a.delivery === "reference");
  if (!references.length) return payload;
  const encoded = await encodeAttachments(
    messageToEditorContent({ text: "", attachments: references }).attachments,
    context,
  );
  if (encoded.skipped.length)
    throw new Error(
      encoded.skipped.map((a) => `${a.name}: ${a.reason}`).join("; "),
    );
  let index = 0;
  const attachments = payload.attachments?.map((block) => {
    if (
      block.type !== "text" ||
      !block.text.startsWith("<attached_file ") ||
      !block.text.endsWith("\n</attached_file>")
    )
      return block;
    const replacement = encoded.blocks[index++];
    if (!replacement)
      throw new Error(
        "The queued attachment references are incomplete — edit the message and attach them again",
      );
    return replacement;
  });
  if (index !== references.length)
    throw new Error(
      "The queued attachment references are incomplete — edit the message and attach them again",
    );
  const refreshed = new Map(
    references.map((a, i) => [a, encoded.bubbleAttachments[i]!]),
  );
  const segments = payload.segments?.map((segment) => {
    if (segment.type !== "attachment" || segment.delivery !== "reference")
      return segment;
    const original = references.find(
      (a) =>
        a.attachmentId === segment.attachmentId &&
        a.diskPath === segment.diskPath &&
        a.name === segment.name,
    );
    if (!original)
      throw new Error(
        "The queued attachment metadata is incomplete — edit the message and attach it again",
      );
    return { ...segment, ...refreshed.get(original)! };
  });
  return {
    attachments,
    bubbleAttachments: originals.map((a) => refreshed.get(a) ?? a),
    segments,
  };
}
