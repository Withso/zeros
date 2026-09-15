import { validateAttachmentFile } from "@zeros/protocol/attachment-policy";
import type { ComposerAttachment } from "../composer-attachments";
import { prepareAttachmentSource } from "../attachment-sources";

/** Clipboard/transcript text follows the same path-delivery policy as imports.
 * Keep the supplied string out of persistent composer state. */
export function textFileAttachment(
  name: string,
  text: string,
): ComposerAttachment {
  const sourceFile = new Blob([text], { type: "text/plain" });
  const validation = validateAttachmentFile({
    name,
    mimeType: sourceFile.type,
    size: sourceFile.size,
  });
  const attachment: ComposerAttachment = {
    id: `att-${crypto.randomUUID()}`,
    name,
    mimeType: sourceFile.type,
    kind: "text",
    delivery: "reference",
    size: sourceFile.size,
    data: "",
    validation,
    ...(validation.ok ? { sourceFile } : {}),
  };
  if (validation.ok) void prepareAttachmentSource(attachment).catch(() => {});
  return attachment;
}

export interface FilesToAttachmentsOpts {
  agentName: string | null | undefined;
  agentSupportsImage: boolean | undefined;
  modelId: string | null | undefined;
}

/** Selection creates metadata and starts source recovery without awaiting I/O.
 * Staging copies into the owning workspace; send awaits its confirmed path. */
export async function filesToAttachments(
  files: FileList | File[] | null | undefined,
  _opts: FilesToAttachmentsOpts,
): Promise<ComposerAttachment[]> {
  return Array.from(files ?? []).map((file) => {
    const validation = validateAttachmentFile({
      name: file.name,
      mimeType: file.type,
      size: file.size,
    });
    const kind = file.type.startsWith("image/") ? "image" : "file";
    const attachment: ComposerAttachment = {
      id: `att-${crypto.randomUUID()}`,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      kind,
      delivery: "reference",
      data: "",
      size: file.size,
      validation,
      ...(validation.ok ? { sourceFile: file } : {}),
    };
    if (validation.ok) void prepareAttachmentSource(attachment).catch(() => {});
    return attachment;
  });
}
