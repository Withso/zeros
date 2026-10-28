import type { JSONContent } from "@tiptap/core";
import type { MessageContentSegment } from "@zeros/protocol/agent-messages";
import type { ComposerAttachment } from "../composer-attachments";

export const MAX_ATTACHMENT_GROUP_FILES = 1000;

/** Group membership lives on the editor atom; source ownership and delivery
 * still belong to each file. Invalid metadata never hides the primary file. */
export function attachmentNodeIds(attrs: Record<string, unknown>): string[] {
  const first =
    typeof attrs.attachmentId === "string" ? attrs.attachmentId : "";
  if (!Array.isArray(attrs.attachmentIds)) return first ? [first] : [];
  return [
    ...new Set([
      first,
      ...attrs.attachmentIds.slice(0, MAX_ATTACHMENT_GROUP_FILES),
    ]),
  ]
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .slice(0, MAX_ATTACHMENT_GROUP_FILES);
}

export function attachmentNodeContent(
  files: readonly ComposerAttachment[],
  groupName?: string,
): JSONContent[] {
  if (!files.length) return [];
  // Keep exceptionally large selections complete in bounded groups.
  const content: JSONContent[] = [];
  for (
    let index = 0;
    index < files.length;
    index += MAX_ATTACHMENT_GROUP_FILES
  ) {
    const batch = files.slice(index, index + MAX_ATTACHMENT_GROUP_FILES);
    const first = batch[0];
    content.push(
      {
        type: "attachment",
        attrs: {
          attachmentId: first.id,
          name: batch.length > 1 && groupName ? groupName : first.name,
          mimeType: first.mimeType,
          kind: first.kind,
          ...(batch.length > 1
            ? {
                attachmentIds: batch.map((file) => file.id),
                groupId: `group-${crypto.randomUUID()}`,
              }
            : {}),
        },
      },
      { type: "text", text: " " },
    );
  }
  return content;
}

export function validAttachmentGroup(
  value: unknown,
): value is { id: string; name: string } {
  if (!value || typeof value !== "object") return false;
  const group = value as { id?: unknown; name?: unknown };
  return (
    typeof group.id === "string" &&
    group.id.length > 0 &&
    group.id.length <= 160 &&
    typeof group.name === "string" &&
    group.name.length > 0 &&
    group.name.length <= 512
  );
}

export type AttachmentSegment = Extract<
  MessageContentSegment,
  { type: "attachment" }
>;
export type GroupedMessageSegment =
  | Exclude<MessageContentSegment, { type: "attachment" }>
  | AttachmentSegment
  | {
      type: "attachment-group";
      id: string;
      name: string;
      files: AttachmentSegment[];
    };

/** Only adjacent segments form a group. A repeated id elsewhere in a message
 * cannot pull files across prose or another atom. Older clients render all
 * these same attachment segments individually. */
export function groupMessageSegments(
  segments: readonly MessageContentSegment[],
): GroupedMessageSegment[] {
  const result: GroupedMessageSegment[] = [];
  for (const segment of segments) {
    if (segment.type !== "attachment" || !validAttachmentGroup(segment.group)) {
      result.push(segment);
      continue;
    }
    const previous = result.at(-1);
    if (
      previous?.type === "attachment-group" &&
      previous.id === segment.group.id &&
      previous.files.length < MAX_ATTACHMENT_GROUP_FILES
    ) {
      previous.files.push(segment);
    } else {
      result.push({
        type: "attachment-group",
        ...segment.group,
        files: [segment],
      });
    }
  }
  return result;
}
