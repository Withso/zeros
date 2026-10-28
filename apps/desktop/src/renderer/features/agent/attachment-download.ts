import { readWorkspaceFile } from "@/renderer/platform/files";
import { openWorkspaceMedia } from "@/renderer/platform/file-media";
import { workspaceFileAccessKey } from "@/renderer/platform/workspace-file-scope";
import { attachmentOwner, sameAttachmentOwner } from "./attachment-owner";
import { prepareAttachmentSource } from "./attachment-sources";
import { ensureFileAttachment } from "./file-attachment-transfer";
import type { ComposerAttachment } from "./composer-attachments";

/** Download the original bytes, including a selected file that is still saving. */
export async function downloadAttachment(
  attachment: ComposerAttachment,
  cwd: string | null | undefined,
  signal: AbortSignal,
): Promise<void> {
  const access = cwd ? workspaceFileAccessKey(cwd) : null;
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (cwd && workspaceFileAccessKey(cwd) !== access)
      throw new Error("The attachment workspace changed.");
    if (
      attachment.owner &&
      (!cwd || !sameAttachmentOwner(attachment.owner, attachmentOwner(cwd)))
    )
      throw new Error("Open this attachment in its original workspace.");
  };
  assertCurrent();
  const blob =
    attachment.sourceFile ??
    (attachment.sourceRecoveryId
      ? (await prepareAttachmentSource(attachment)).blob
      : undefined);
  assertCurrent();
  if (blob) {
    const url = URL.createObjectURL(blob);
    try {
      downloadUrl(url, attachment.name);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    return;
  }
  if (!cwd) throw new Error("Attach this file again to download it.");
  const saved = await ensureFileAttachment(cwd, attachment);
  assertCurrent();
  const result = await readWorkspaceFile(cwd, saved.relativePath, {
    includeVideo: true,
    streamMedia: true,
  });
  assertCurrent();
  if (result?.media) {
    const lease = await openWorkspaceMedia({
      cwd,
      path: saved.relativePath,
      bytes: result.bytes,
      media: result.media,
    });
    try {
      assertCurrent();
      await lease.download(attachment.name);
    } finally {
      lease.release();
    }
  } else if (result?.dataUrl) downloadUrl(result.dataUrl, attachment.name);
  else throw new Error("This file is no longer available to download.");
}

function downloadUrl(url: string, name: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}
