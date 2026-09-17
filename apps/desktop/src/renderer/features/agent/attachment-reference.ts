/** A plain-text file reference works across every harness, just like a composer
 * file mention. JSON quoting keeps names and paths with whitespace or markup
 * unambiguous without changing the path the agent must open. */
export function attachmentReferenceBlock(input: {
  name: string;
  mimeType: string;
  absolutePath: string;
}): string {
  const instruction = input.mimeType.startsWith("image/")
    ? "Open this image with an image-reading tool before using it."
    : "Read this file with the appropriate tools; inspect the portions needed for the request.";
  return [
    `Attached file: ${JSON.stringify(input.name)} (${input.mimeType})`,
    `Path: ${JSON.stringify(input.absolutePath)}`,
    instruction,
  ].join("\n");
}

/** Wire references are all text blocks. Product counts follow the original
 * file kinds, with the old content-block fallback only for sends lacking chips. */
export function countPromptAttachments(
  blocks: ContentBlock[] | undefined,
  attachments?: AgentTextMessageAttachment[],
): { image: number; text: number } {
  return attachments
    ? {
        image: attachments.filter((a) => a.kind === "image").length,
        text: attachments.filter((a) => a.kind !== "image").length,
      }
    : {
        image: blocks?.filter((b) => b.type === "image").length ?? 0,
        text: blocks?.filter((b) => b.type === "text").length ?? 0,
      };
}
import type { ContentBlock } from "../../platform/bridge/agent-events";
import type { AgentTextMessageAttachment } from "@zeros/protocol/agent-messages";
