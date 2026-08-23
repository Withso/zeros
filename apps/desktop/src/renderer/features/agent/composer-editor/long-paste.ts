// Long clipboard text is a file, not an unbounded inline composer mutation.
// Keep the boundary and clipboard precedence in this DOM-free module so all
// composer surfaces share one exact, regression-tested policy.

import { validateAttachment } from "../agent-attachments";
import type { ComposerAttachment } from "../composer-attachments";

/** Pasting strictly more than this many Unicode code points creates a .txt
 * attachment. Typing is never subject to this limit, and exactly 3,000
 * characters still follows ProseMirror's normal inline paste path. */
export const LONG_PASTE_CHARACTER_LIMIT = 3_000;

/** Attachment folders are keyed by a unique id, so a stable human-readable
 * filename remains unambiguous on disk while staying compact in the pill. */
export const LONG_PASTE_ATTACHMENT_NAME = "pasted-text.txt";

export type ComposerPastePayload =
  | { kind: "files"; files: FileList }
  | { kind: "long-text"; text: string };

export interface LongPasteAttachmentOpts {
  agentName: string | null | undefined;
  agentSupportsImage: boolean | undefined;
  modelId: string | null | undefined;
}

/** Count code points rather than UTF-16 code units, stopping as soon as the
 * answer is known. This keeps emoji from counting twice and makes even a
 * multi-megabyte clipboard payload cost at most 3,001 loop iterations. */
function exceedsLongPasteLimit(text: string): boolean {
  let characters = 0;
  for (const _character of text) {
    characters += 1;
    if (characters > LONG_PASTE_CHARACTER_LIMIT) return true;
  }
  return false;
}

/** Classify only the clipboard payload involved in this paste; existing text
 * in the composer does not affect the threshold. Native clipboard files keep
 * priority over fallback text some platforms publish beside those files. */
export function classifyComposerPaste(
  clipboardData: Pick<DataTransfer, "files" | "getData"> | null | undefined,
): ComposerPastePayload | null {
  if (!clipboardData) return null;
  if (clipboardData.files.length > 0) {
    return { kind: "files", files: clipboardData.files };
  }
  const text = clipboardData.getData("text/plain");
  return exceedsLongPasteLimit(text) ? { kind: "long-text", text } : null;
}

/** Build the ordinary text attachment shape consumed by serialization, send,
 * draft restore, and context-graph staging. The clipboard already supplied a
 * string, so this path stays synchronous and preserves it byte-for-byte. */
export function longPasteToAttachment(
  text: string,
  opts: LongPasteAttachmentOpts,
): ComposerAttachment {
  const size = new TextEncoder().encode(text).length;
  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: LONG_PASTE_ATTACHMENT_NAME,
    mimeType: "text/plain",
    kind: "text",
    data: "",
    text,
    size,
    validation: validateAttachment({
      kind: "text",
      size,
      agentName: opts.agentName ?? null,
      agentSupportsImage: opts.agentSupportsImage,
      modelId: opts.modelId ?? null,
    }),
  };
}
