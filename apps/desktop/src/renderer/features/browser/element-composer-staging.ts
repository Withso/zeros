import { validateAttachmentFile } from "@zeros/protocol/attachment-policy";

import {
  deliverFilesToChat,
  type ComposerFileDeliveryOutcome,
} from "../agent/composer-file-attachment-delivery";
import { toast } from "../../shared/ui/primitives/elements";
import type { SelectedElement } from "./use-iframe-webview";

/** Format one element as the multi-line block an agent can turn into concrete
 * diffs: identity, selector, URL, shadow-DOM note and computed styles. */
function elementBlock(el: SelectedElement, fallbackUrl: string): string {
  const styleLines = el.styles
    ? Object.entries(el.styles)
        .filter(([, v]) => v && v !== "auto" && v !== "normal" && v !== "none")
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n")
    : "";
  // The component name is what the user sees in the chip and recognizes from
  // their own code; the bare tag is the fallback.
  const heading = el.componentName
    ? `${el.componentName} (<${el.tag}>)`
    : `<${el.tag}>`;
  return (
    `${heading}\n` +
    `  selector: ${el.selector}\n` +
    `  url: ${el.href || fallbackUrl}` +
    (el.hasShadowRoot ? "\n  note: inside shadow-DOM" : "") +
    (styleLines ? `\n  computed styles:\n${styleLines}` : "")
  );
}

/** The user's prompt followed by every selected element's details. One element
 * reads "Selected element: …"; several become a numbered list. */
export function buildElementDetailsText(
  elements: readonly SelectedElement[],
  prompt: string,
  tabUrl: string,
): string {
  const details =
    elements.length === 1
      ? `Selected element: ${elementBlock(elements[0], tabUrl)}`
      : `Selected ${elements.length} elements:\n\n` +
        elements
          .map((el, i) => `${i + 1}. ${elementBlock(el, tabUrl)}`)
          .join("\n\n");
  const userText = prompt.trim();
  return userText ? `${userText}\n\n${details}` : details;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function fileNameSegment(value: string): string {
  const segment = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return segment || "element";
}

/** Decode a picker screenshot (`data:image/png;base64,…`) into a File named
 * from its real MIME type. Null for a missing or malformed capture, which the
 * picker produces when the element is scrolled out of view. */
export function elementScreenshotFile(
  el: SelectedElement,
  index: number,
): File | null {
  const match = el.screenshot?.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const extension = IMAGE_EXTENSIONS[mimeType];
  if (!extension) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  return new File(
    [bytes as BlobPart],
    `${fileNameSegment(el.tag)}-${index + 1}.${extension}`,
    { type: mimeType },
  );
}

export function elementDetailsFileName(
  elements: readonly SelectedElement[],
): string {
  if (elements.length !== 1) return "selected-elements.txt";
  const el = elements[0];
  return `${fileNameSegment(el.componentName || el.tag)}-details.txt`;
}

/** Every file staged for one submission: screenshots in selection order, then
 * the details text. */
export function buildElementComposerFiles(
  elements: readonly SelectedElement[],
  prompt: string,
  tabUrl: string,
): File[] {
  const files: File[] = [];
  elements.forEach((el, i) => {
    const image = elementScreenshotFile(el, i);
    if (image) files.push(image);
  });
  files.push(
    new File(
      [buildElementDetailsText(elements, prompt, tabUrl)],
      elementDetailsFileName(elements),
      { type: "text/plain" },
    ),
  );
  return files;
}

export interface StageSelectedElementsArgs {
  elements: readonly SelectedElement[];
  prompt: string;
  tabUrl: string;
  activeChatId: string | null;
}

export type StageSelectedElementsResult =
  | {
      ok: true;
      chatId: string;
      outcome: ComposerFileDeliveryOutcome;
      files: File[];
    }
  | { ok: false; reason: "no-active-chat" | "no-elements" | "invalid-file" };

/** Stage the selection into the active chat's composer without sending: one
 * image pill per captured screenshot plus one text pill holding the prompt and
 * element details. The composer's typed text is left alone; the user reviews
 * and sends normally. On failure the caller keeps its prompt input open. */
export function stageSelectedElementsInComposer({
  elements,
  prompt,
  tabUrl,
  activeChatId,
}: StageSelectedElementsArgs): StageSelectedElementsResult {
  if (!activeChatId) {
    toast.error("No active chat to attach this element to.", {
      description: "Open or create a chat first.",
    });
    return { ok: false, reason: "no-active-chat" };
  }
  if (elements.length === 0) return { ok: false, reason: "no-elements" };
  const files = buildElementComposerFiles(elements, prompt, tabUrl);
  for (const file of files) {
    const validation = validateAttachmentFile({
      name: file.name,
      mimeType: file.type,
      size: file.size,
    });
    if (!validation.ok) {
      toast.error(`Couldn't attach "${file.name}" to the chat.`, {
        description: validation.reason,
      });
      return { ok: false, reason: "invalid-file" };
    }
  }
  const outcome = deliverFilesToChat(activeChatId, {
    id: `browser-elements-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    files,
  });
  return { ok: true, chatId: activeChatId, outcome, files };
}
