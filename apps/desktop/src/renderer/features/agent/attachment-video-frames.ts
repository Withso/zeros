import { readWorkspaceFile } from "@/renderer/platform/files";
import { openWorkspaceMedia } from "@/renderer/platform/file-media";
import { videoContextFiles } from "./composer-editor/video-context-files";
import { prepareAttachmentSource } from "./attachment-sources";
import { ensureFileAttachment } from "./file-attachment-transfer";
import type { ComposerAttachment } from "./composer-attachments";
import { attachmentOwner, sameAttachmentOwner } from "./attachment-owner";

export async function attachmentVideoFrames(
  attachment: ComposerAttachment,
  cwd: string | null | undefined,
  signal: AbortSignal,
): Promise<File[]> {
  signal.throwIfAborted();
  if (
    attachment.owner &&
    (!cwd || !sameAttachmentOwner(attachment.owner, attachmentOwner(cwd)))
  )
    throw new Error("Open this video in its original workspace.");
  const source =
    attachment.sourceFile ??
    (attachment.sourceRecoveryId
      ? (await prepareAttachmentSource(attachment)).blob
      : undefined);
  signal.throwIfAborted();
  if (source)
    return videoContextFiles({ name: attachment.name, blob: source }, signal);
  if (!cwd) throw new Error("Attach the video again to extract its frames.");
  const saved = await ensureFileAttachment(cwd, attachment);
  signal.throwIfAborted();
  const result = await readWorkspaceFile(cwd, saved.relativePath, {
    includeVideo: true,
    streamMedia: true,
  });
  signal.throwIfAborted();
  if (!result || result.kind !== "video")
    throw new Error("This video can't be read for frames.");
  if (result.dataUrl)
    return videoContextFiles(
      { name: attachment.name, url: result.dataUrl },
      signal,
    );
  if (!result.media) throw new Error("This video can't be read for frames.");
  const lease = await openWorkspaceMedia({
    cwd,
    path: saved.relativePath,
    bytes: result.bytes,
    media: result.media,
  });
  try {
    signal.throwIfAborted();
    return await videoContextFiles(
      { name: attachment.name, url: lease.url },
      signal,
    );
  } finally {
    lease.release();
  }
}
