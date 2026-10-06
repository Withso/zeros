import { encodeAttachments } from "./encode-attachments";
import { toMessageSegments, type ComposerSerialized } from "./composer-editor/serialize";
import type { ComposerAttachment } from "./composer-attachments";
import type { QueuedEditPayload } from "./sessions-context";
import type { AgentTextMessageAttachment, MessageContentSegment } from "./use-agent-session";
import type { ContentBlock } from "../../platform/bridge/agent-events";
import { CloudSendWaitError } from "./cloud-send-wait";

/** Capture rich cloud content before waking. File resolution runs only after
 * readiness, while the FIFO still owns an editable/removable draft. */
export function cloudQueuedPrompt(input: {
  cwd: string; chatId: string; agentId?: string | null;
  text: string; displayText: string; snapshot: ComposerSerialized | null;
  stagedAttachments?: ComposerAttachment[];
  extraAttachments?: ContentBlock[];
  bubbleAttachments?: AgentTextMessageAttachment[];
  segments?: MessageContentSegment[];
  prepareAdditional?: () => Promise<ComposerAttachment[]>;
}): QueuedEditPayload {
  const attachments = [...(input.snapshot?.attachments ?? []), ...(input.stagedAttachments ?? [])].map(a => ({ ...a }));
  const chips = attachments.map(a => ({ name: a.name, mimeType: a.mimeType, kind: a.kind,
    size: a.size, delivery: a.delivery, diskPath: a.diskPath, attachmentId: a.contextAttachmentId ?? a.id }));
  const payload = { text: input.text, displayText: input.displayText,
    bubbleAttachments: [...chips, ...(input.bubbleAttachments ?? [])],
    segments: input.snapshot ? toMessageSegments(input.snapshot.segments, attachments,
      new Map(attachments.map((a, i) => [a.id, chips[i]!]))) : input.segments };
  return {
    ...payload,
    cloudQueue: {
      draft: { json: input.snapshot?.json ?? null, attachments, prepareAdditional: input.prepareAdditional },
      prepare: async supportsImage => {
        const additional = await input.prepareAdditional?.() ?? [];
        const encoded = await encodeAttachments([...attachments, ...additional], {
          cwd: input.cwd, chatId: input.chatId, agentId: input.agentId, supportsImage,
        });
        if (encoded.skipped.length) throw new CloudSendWaitError(encoded.skipped.map(a => `${a.name}: ${a.reason}`).join("; "));
        const segments = input.snapshot
          ? toMessageSegments(input.snapshot.segments, attachments, encoded.bubbleAttachmentById)
          : input.segments ? [...input.segments] : undefined;
        if (segments) for (const a of additional) segments.push(...toMessageSegments([{
          type: "attachment", attachmentId: a.id, name: a.name, mimeType: a.mimeType, kind: a.kind,
        }], [a], encoded.bubbleAttachmentById));
        return { text: input.text, displayText: input.displayText,
          attachments: [...encoded.blocks, ...(input.extraAttachments ?? [])],
          bubbleAttachments: [...encoded.bubbleAttachments, ...(input.bubbleAttachments ?? [])], segments };
      },
    },
  };
}
