import {
  contextAttachmentPath,
  safeAttachmentFilename,
} from "@zeros/protocol/attachment-policy";
import { offerPendingFilePreview } from "@/renderer/platform/pending-file-preview";
import { openFileGroup } from "@/renderer/shell/workbench/file-group-navigation";
import { attachmentOwner, sameAttachmentOwner } from "./attachment-owner";
import { getFileAttachmentProgress } from "./file-attachment-transfer";
import type { ComposerAttachment } from "./composer-attachments";

export function openComposerAttachmentGroup(
  cwd: string | null | undefined,
  id: string,
  name: string,
  files: readonly ComposerAttachment[],
): void {
  if (
    !cwd ||
    !files.length ||
    files.some(
      (file) =>
        file.owner && !sameAttachmentOwner(file.owner, attachmentOwner(cwd)),
    )
  )
    return;
  const members = files.map((file) => {
    const attachmentId = file.contextAttachmentId ?? file.id;
    const path =
      getFileAttachmentProgress(cwd, attachmentId)?.diskPath ??
      file.diskPath ??
      contextAttachmentPath(attachmentId, safeAttachmentFilename(file.name));
    if (file.sourceFile) offerPendingFilePreview(cwd, path, file.sourceFile);
    return { name: file.name, path, attachmentId };
  });
  openFileGroup(cwd, { id, name, files: members });
}
