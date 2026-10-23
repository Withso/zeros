import { constants } from "node:fs";
import { link, open, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ContentBlock } from "@zeros/protocol/agent-events";
import { cloudPromptAttachmentFile } from "@zeros/protocol/cloud-v2-prompts";
import { CheckedFiles, descriptorPath } from "./workspace/checked-files";
import { WorkspaceError, type WorkspaceScope } from "./workspace/scope";

const refused = () => new WorkspaceError("ATTACHMENT_UNAVAILABLE", "This attachment could not be saved. Attach it again before sending.");

/** Inbox JSON retains the original bytes for crash recovery and replay checks.
 * Only this prepared copy reaches the driver. A reused attachment identity may
 * confirm identical bytes, but can never silently replace a previous file. */
export async function preparePromptFiles(scope: WorkspaceScope, content: ContentBlock[]): Promise<ContentBlock[]> {
  const files = new CheckedFiles(scope), result: ContentBlock[] = [];
  for (const block of content) {
    if (block.type !== "resource" || !block.resource.uri.startsWith("zeros-attachment:")) { result.push(block); continue; }
    try {
      const item = cloudPromptAttachmentFile(block.resource.uri);
      if (!("blob" in block.resource) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.resource.blob)) throw refused();
      const bytes = Buffer.from(block.resource.blob, "base64");
      const { parent } = await files.writeParent(item.path);
      const temp = `${descriptorPath(parent)}/.zeros-attachment-${randomUUID()}`;
      try {
        await files.assertDescriptor(parent);
        const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await files.assertDescriptor(parent);
        try { await link(temp, `${descriptorPath(parent)}/${basename(item.path)}`); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = await files.file(item.path);
          try {
            if ((await existing.stat()).size !== bytes.length || !(await existing.readFile()).equals(bytes)) throw refused();
            await files.assertDescriptor(existing);
          } finally { await existing.close(); }
        }
        await parent.sync();
      } finally { await rm(temp, { force: true }).catch(() => {}); await parent.close(); }
      const mimeType = block.resource.mimeType ?? "application/octet-stream";
      result.push({ type: "text", text: [`Attached file: ${JSON.stringify(item.name)} (${mimeType})`,
        `Path: ${JSON.stringify(scope.path(item.path))}`, mimeType.startsWith("image/")
          ? "Open this image with an image-reading tool before using it."
          : "Read this file with the appropriate tools; inspect the portions needed for the request."].join("\n") });
    } catch { throw refused(); }
  }
  return result;
}
