import { CLOUD_V2_MAX_PROMPT_BYTES, cloudPromptAttachmentFile } from "@zeros/protocol/cloud-v2-prompts";
import { attachmentOwner, sameAttachmentOwner } from "./attachment-owner";
import { prepareAttachmentSource, supplyLegacyAttachmentBytes } from "./attachment-sources";
import type { ComposerAttachment } from "./composer-attachments";
import type { EncodedAttachments } from "./encode-attachments";

const missing = () => new Error("An attachment is unavailable. Attach it again before sending.");
const reference = (name: string, path: string, mime: string) => ({ type: "text" as const,
  text: [`Attached file: ${JSON.stringify(name)} (${mime})`, `Path: ${JSON.stringify(path)}`,
    mime.startsWith("image/") ? "Open this image with an image-reading tool before using it." : "Read this file with the appropriate tools; inspect the portions needed for the request."].join("\n") });

/** Byte preparation stays on the desktop. It needs neither a running VM nor
 * a live bridge. Confirmed references are reusable only for their exact cloud
 * owner; all other attachments must carry bytes in the committed HTTP body. */
export async function encodeCloudPromptAttachments(attachments: ComposerAttachment[], cwd: string): Promise<EncodedAttachments> {
  const result: EncodedAttachments = { blocks: [], bubbleAttachments: [], bubbleAttachmentById: new Map(), skipped: [] };
  let total = 0;
  for (const original of attachments) {
    if (original.unavailable || !original.validation.ok) throw missing();
    const attachment = { ...original }; supplyLegacyAttachmentBytes(attachment);
    let bytes: Blob | undefined;
    try { bytes = (await prepareAttachmentSource(attachment, true)).blob; } catch { /* exact confirmed references may still be used */ }
    let id = attachment.contextAttachmentId ?? attachment.id, path: string;
    if (bytes) {
      total += bytes.size;
      if (total > CLOUD_V2_MAX_PROMPT_BYTES * 0.7) throw new Error("These attachments are too large. Send fewer files.");
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) id = crypto.randomUUID();
      const uri = `zeros-attachment://${id}/${encodeURIComponent(attachment.name)}`;
      path = cloudPromptAttachmentFile(uri).path;
      const data = new Uint8Array(await bytes.arrayBuffer()); let binary = "";
      for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
      result.blocks.push({ type: "resource", resource: { uri, mimeType: attachment.mimeType, blob: btoa(binary) } });
    } else {
      if (attachment.delivery !== "reference" || !sameAttachmentOwner(attachment.owner, attachmentOwner(cwd)) ||
          !attachment.diskPath || !/^\.context(?:-graph)?\/(?:local|shared)\/attachments\//.test(attachment.diskPath) ||
          attachment.diskPath.includes("\\") || [...attachment.diskPath].some(char => char.charCodeAt(0) < 0x20) || attachment.diskPath.split("/").some(part => part === "..")) throw missing();
      path = attachment.diskPath; result.blocks.push(reference(attachment.name, path, attachment.mimeType));
    }
    const bubble = { name: attachment.name, mimeType: attachment.mimeType, kind: attachment.kind,
      size: bytes?.size ?? attachment.size, delivery: "reference" as const, diskPath: path, attachmentId: id };
    result.bubbleAttachments.push(bubble); result.bubbleAttachmentById.set(original.id, bubble);
  }
  return result;
}
