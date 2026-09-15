import { useRef } from "react";
import { attachmentTextPreviewsCache } from "../../../state/read-caches";
import { useCachedRead } from "../../../state/use-cached-read";
import {
  readTextAttachment,
  writeContextAttachment,
} from "../agent-history-client";
import { TranscriptPreviewShell } from "../chat-transcript-preview";
import type {
  ComposerAttachment,
  ComposerAttachmentPreview,
} from "../composer-attachments";

// Synthetic transcripts have a 2M-character formatter limit. Allow their
// worst-case UTF-8 size without reading an arbitrary 500 MB import for hover.
export const MAX_ATTACHMENT_PREVIEW_BYTES = 8_000_000;
const PREVIEW_MAX_AGE_MS = 30_000;

export function attachmentTextPreviewKey(
  cwd: string | null | undefined,
  attachment: ComposerAttachment,
): string {
  return JSON.stringify([
    cwd ?? null,
    attachment.contextAttachmentId ?? attachment.id,
    attachment.name,
  ]);
}

export async function readAttachmentTextPreview(
  cwd: string | null | undefined,
  attachment: ComposerAttachment,
): Promise<string> {
  if (attachment.sourceFile) {
    if (attachment.sourceFile.size > MAX_ATTACHMENT_PREVIEW_BYTES)
      throw new Error("Attachment is too large to preview");
    return attachment.sourceFile.text();
  }
  if (attachment.delivery !== "reference" && attachment.text != null)
    return attachment.text;
  if (!cwd) throw new Error("Attachment workspace is unavailable");
  const attachmentId = attachment.contextAttachmentId ?? attachment.id;
  let diskPath = attachment.diskPath;
  if (attachment.delivery === "reference") {
    // Resolve the exact record, including scope/root moves and a restored
    // draft saved before the attach-time write published its diskPath.
    const resolved = await writeContextAttachment({
      cwd,
      attachmentId,
      filename: attachment.name,
      mimeType: attachment.mimeType,
      base64: "",
      resolve: true,
    });
    diskPath = resolved.relativePath;
  }
  const text = await readTextAttachment({ cwd, attachmentId, diskPath });
  if (text === null) throw new Error("Saved attachment preview is unavailable");
  return text;
}

export function warmAttachmentTextPreview(
  cwd: string | null | undefined,
  attachment: ComposerAttachment,
): Promise<string> {
  return attachmentTextPreviewsCache.load(
    attachmentTextPreviewKey(cwd, attachment),
    () => readAttachmentTextPreview(cwd, attachment),
    { maxAgeMs: PREVIEW_MAX_AGE_MS },
  );
}

/** Mounted only for an open, active hover card. The parent keys this component
 * by workspace and attachment identity, so late reads cannot cross owners. */
export function AttachmentTextPreview({
  cwd,
  attachment,
  preview,
  active,
}: {
  cwd?: string | null;
  attachment: ComposerAttachment;
  preview: ComposerAttachmentPreview;
  active: boolean;
}) {
  const request = useRef({ cwd, attachment: { ...attachment } }).current;
  const snapshot = useCachedRead(
    attachmentTextPreviewsCache,
    attachmentTextPreviewKey(request.cwd, request.attachment),
    () => readAttachmentTextPreview(request.cwd, request.attachment),
    { maxAgeMs: PREVIEW_MAX_AGE_MS, enabled: active },
  );
  return <TranscriptPreviewShell {...preview} body={snapshot.data ?? null} />;
}
