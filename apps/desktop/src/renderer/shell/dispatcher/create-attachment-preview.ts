import type { ComposerAttachment } from "../../features/agent/composer-attachments";
import { prepareAttachmentSource, supplyLegacyAttachmentBytes } from "../../features/agent/attachment-sources";

export const MAX_CREATE_TEXT_PREVIEW_BYTES = 1_000_000;
export type CreateAttachmentPreview = {
  blob: Blob;
  kind: "text" | "markdown" | "image" | "video" | "audio" | "unsupported";
  text?: string;
  truncated?: boolean;
};
const mediaTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", heic: "image/heic",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", ogv: "video/ogg",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg",
  pdf: "application/pdf",
};

/** Reads a bounded text prefix; media stays a Blob and streams through a local
 * object URL. No workspace read, upload, or provider request is involved. */
export async function readCreateAttachmentPreview(attachment: ComposerAttachment): Promise<CreateAttachmentPreview> {
  if (attachment.unavailable) throw new Error("This attachment is unavailable. Attach it again to preview it.");
  const source = { ...attachment };
  supplyLegacyAttachmentBytes(source);
  const blob = (await prepareAttachmentSource(source, true)).blob;
  if (!blob || blob.size !== attachment.size) throw new Error("This attachment is unavailable. Attach it again to preview it.");
  const extension = attachment.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = Object.hasOwn(mediaTypes, extension) ? mediaTypes[extension] : attachment.mimeType.toLowerCase().split(";")[0];
  // Chromium's PDF plugin is disabled inside a sandboxed frame. Keep an honest
  // download fallback instead of a blank document or an unsandboxed embed.
  if (mime === "application/pdf") return { kind: "unsupported", blob: blob.slice(0, blob.size, mime) };
  const mediaKind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : null;
  if (mediaKind) return { kind: mediaKind, blob: blob.slice(0, blob.size, mime) };
  const sample = new Uint8Array(await blob.slice(0, Math.min(blob.size, MAX_CREATE_TEXT_PREVIEW_BYTES)).arrayBuffer());
  let text: string;
  try {
    if (sample.includes(0)) return { kind: "unsupported", blob };
    // Streaming decode tolerates a truncated final UTF-8 code point, without
    // interpreting arbitrary binary data as text.
    text = new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: blob.size > sample.length });
  } catch { return { kind: "unsupported", blob }; }
  return { kind: /^(md|markdown|mdx)$/.test(extension) ? "markdown" : "text", blob, text, truncated: blob.size > sample.length };
}
