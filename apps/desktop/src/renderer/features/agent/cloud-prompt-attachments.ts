import { parseContextAttachmentPath, validateAttachmentFile } from "@zeros/protocol/attachment-policy";
import { attachmentOwner, sameAttachmentOwner } from "./attachment-owner";
import { supplyLegacyAttachmentBytes } from "./attachment-sources";
import { ensureFileAttachment } from "./file-attachment-transfer";
import type { ComposerAttachment } from "./composer-attachments";
import type { EncodedAttachments } from "./encode-attachments";

const missing = () => new Error("An attachment is unavailable. Attach it again before sending.");
const reference = (name: string, path: string, mime: string) => ({ type: "text" as const,
  text: [`Attached file: ${JSON.stringify(name)} (${mime})`, `Path: ${JSON.stringify(path)}`,
    mime.startsWith("image/") ? "Open this image with an image-reading tool before using it." : "Read this file with the appropriate tools; inspect the portions needed for the request."].join("\n") });

/** Attach-time and Send share bounded uploads. Only complete workspace file
 * references enter the durable HTTP outbox; its 8 MiB message limit stays small.
 * Already-confirmed same-owner references also work while the VM is asleep. */
export async function encodeCloudPromptAttachments(attachments: ComposerAttachment[], cwd: string): Promise<EncodedAttachments> {
  const result: EncodedAttachments = { blocks: [], bubbleAttachments: [], bubbleAttachmentById: new Map(), skipped: [] };
  for (const attachment of attachments) {
    if (attachment.unavailable || !attachment.validation.ok) throw missing();
    const verdict = validateAttachmentFile({ name: attachment.name, mimeType: attachment.mimeType, size: attachment.size });
    if (!verdict.ok) throw new Error(verdict.reason);
    const owner = attachmentOwner(cwd), owned = sameAttachmentOwner(attachment.owner, owner);
    const parsed = attachment.diskPath ? parseContextAttachmentPath(attachment.diskPath) : null;
    if (attachment.diskPath && !parsed) throw missing();
    const id = attachment.contextAttachmentId ?? attachment.id;
    const confirmed = owned && attachment.delivery === "reference" && parsed?.folderId === id && ![".", ".."].includes(parsed.filename);
    let path = confirmed ? attachment.diskPath! : undefined;
    let size = attachment.size;
    if (!path) {
      supplyLegacyAttachmentBytes(attachment);
      if (attachment.owner && !owned && !attachment.sourceFile && !attachment.sourceRecoveryId) throw missing();
      // An external saved path cannot become this workspace's upload target.
      const upload = !owned && attachment.owner ? { ...attachment, diskPath: undefined, absolutePath: undefined } : attachment;
      const saved = await ensureFileAttachment(cwd, upload);
      path = saved.relativePath; size = saved.bytes;
      Object.assign(attachment, { diskPath: path, absolutePath: saved.absolutePath, contextAttachmentId: id, owner, delivery: "reference" });
    }
    result.blocks.push(reference(attachment.name, path, attachment.mimeType));
    const bubble = { name: attachment.name, mimeType: attachment.mimeType, kind: attachment.kind,
      size, delivery: "reference" as const, diskPath: path, attachmentId: id };
    result.bubbleAttachments.push(bubble); result.bubbleAttachmentById.set(attachment.id, bubble);
  }
  return result;
}
