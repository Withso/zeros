// Reading, formatting and placing a text selection made in the chat
// transcript, for the selection popup's Add to chat and Reply actions.

/** Source-key prefixes of the text attachments these actions stage. The pill
 * picks its icon from them, and each staged selection has its own key so a
 * second one adds a pill instead of replacing the first. */
export const CHAT_SELECTION_SOURCE = "chat-selection:";
export const CHAT_REPLY_SOURCE = "chat-reply:";

/** Longer quotes than this go to the agent as a file instead of inline prompt
 * text, the same boundary a long paste uses. */
export const INLINE_QUOTE_CHARACTER_LIMIT = 3_000;

/** Characters kept for the reply popup's two-line quote and a pill label.
 * Rendering a whole selected transcript only to clip it would be wasted
 * layout. */
const PREVIEW_CHARACTERS = 400;

export interface ChatSelection {
  /** The selected text as the user sees it, normalized. */
  text: string;
  /** A live copy, so the anchor follows the text while the page scrolls or the
   *  native selection moves into the reply field. */
  range: Range;
}

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function insideEditable(node: Node): boolean {
  return !!elementOf(node)?.closest(EDITABLE);
}

/** Same text the user sees: no-break and zero-width characters from rendered
 * markup are spaces or nothing, line ends lose trailing spaces, and runs of
 * blank lines between blocks become one. */
export function normalizeSelectionText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

type ShadowSelectionRoot = ShadowRoot & { getSelection?: () => Selection | null };

/** A selection inside a rendered diff's shadow root. The document's selection
 * is retargeted to the host and reads as collapsed there. */
function shadowSelection(root: HTMLElement): ChatSelection | null {
  for (const host of root.querySelectorAll("diffs-container")) {
    const shadow = host.shadowRoot as ShadowSelectionRoot | null;
    if (!shadow?.getSelection) continue;
    const selection = shadow.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) continue;
    const range = selection.getRangeAt(0);
    if (range.startContainer.getRootNode() !== shadow) continue;
    const text = normalizeSelectionText(selection.toString());
    if (!text) continue;
    return { text, range: range.cloneRange() };
  }
  return null;
}

/** The selection inside `root`, the transcript scroller, or null.
 *
 * A drag that starts in the transcript and ends past it (over the composer)
 * is clamped to the transcript, so the highlight shows exactly what will be
 * added. A selection that starts elsewhere, such as Select All, is left alone
 * and ignored. Text typed in an editable (an inline message edit) is never a
 * transcript selection. */
export function readChatSelection(root: HTMLElement): ChatSelection | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  if (selection.isCollapsed) {
    const anchor = selection.anchorNode;
    return anchor && root.contains(anchor) ? shadowSelection(root) : null;
  }
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode || !root.contains(anchorNode)) return null;
  if (!root.contains(focusNode)) {
    const after = anchorNode.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_FOLLOWING;
    if (after) selection.extend(root, root.childNodes.length);
    else selection.extend(root, 0);
    if (selection.isCollapsed) return null;
  }
  const range = selection.getRangeAt(0);
  if (insideEditable(range.startContainer) || insideEditable(range.endContainer)) return null;
  const text = normalizeSelectionText(selection.toString());
  if (!text) return null;
  return { text, range: range.cloneRange() };
}

/** True while the range still covers text: a re-render that removes the
 * selected nodes collapses a live range. */
export function rangeStillSelects(range: Range): boolean {
  return !range.collapsed && range.startContainer.isConnected && range.endContainer.isConnected;
}

/** The text as a Markdown quote, then the reply. The reply attachment and the
 * sent message use this one form, so the agent reads both the same way. */
export function formatReply(quote: string, reply: string): string {
  const quoted = quote
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n${reply.trim()}`;
}

/** What Send immediately sends. A quote past the inline limit is quoted by
 * its opening and goes in full as an attached file, so the message stays
 * readable and the agent still has every word. */
export function replyMessage(quote: string, reply: string): { text: string; attachQuote: boolean } {
  if (quote.length <= INLINE_QUOTE_CHARACTER_LIMIT) return { text: formatReply(quote, reply), attachQuote: false };
  const opening = previewText(quote, 280);
  return { text: formatReply(opening.endsWith("…") ? opening : `${opening}…`, reply), attachQuote: true };
}

/** Why Send immediately must wait, or null when it can send now. The single
 * send in flight would drop a second one, a workspace still being set up has
 * no checkout to send into, and a held permission parks every send. The reply
 * stays open in each case, so nothing typed is lost. */
export function replySendBlocker(input: {
  sendInFlight: boolean;
  provisioning: boolean;
  permission: "send" | "revise-plan" | "hold";
}): { title: string; description: string } | null {
  if (input.sendInFlight) return { title: "The last message is still sending.", description: "Send your reply again in a moment." };
  if (input.provisioning) {
    return { title: "This workspace is still being set up.", description: "Add the reply to the chat instead, or send it once setup finishes." };
  }
  if (input.permission === "hold") return { title: "Answer the permission request first.", description: "Your reply can be sent after it." };
  return null;
}

/** A sent reply's quote and reply text, or null for any other message. The
 * quote is the leading run of `>` lines, then one blank line, then the reply. */
export function parseReply(text: string): { quote: string; reply: string } | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  const quote: string[] = [];
  while (index < lines.length && /^>( |$)/.test(lines[index])) {
    quote.push(lines[index].replace(/^> ?/, ""));
    index += 1;
  }
  if (quote.length === 0 || index >= lines.length || lines[index].trim() !== "") return null;
  const reply = lines.slice(index + 1).join("\n").trim();
  const quoted = quote.join("\n").trim();
  if (!reply || !quoted) return null;
  return { quote: quoted, reply };
}

/** One line of the text, whitespace collapsed, short enough for a pill or
 * the quote preview. */
export function previewText(text: string, characters = PREVIEW_CHARACTERS): string {
  const flat = text.slice(0, characters * 2).replace(/\s+/g, " ").trim();
  return flat.length > characters ? `${flat.slice(0, characters).trimEnd()}…` : flat;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `chat-selection-2026-11-22_00-31-48.txt`: local time, so the name matches
 * the clock the user saw. Each attachment has its own folder, so two in the
 * same second never collide. */
export function chatAttachmentName(kind: "selection" | "reply", at: Date = new Date()): string {
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
  return `chat-${kind}-${date}_${time}.txt`;
}

export interface PlacementInput {
  /** The selection's bounding box. */
  selection: Pick<DOMRect, "top" | "bottom" | "left" | "right">;
  /** The transcript's visible box. */
  bounds: Pick<DOMRect, "top" | "bottom" | "left" | "right">;
  width: number;
  height: number;
  /** Keep the popup on screen while the selection is scrolled away, instead
   *  of hiding it. A reply being typed must not vanish. */
  pin: boolean;
  /** The side used last time, kept while it still fits so a growing reply
   *  does not jump across the selection. */
  previous?: "top" | "bottom" | "inside" | null;
}

export interface Placement {
  x: number;
  y: number;
  side: "top" | "bottom" | "inside";
}

export const POPUP_GAP = 6;
export const POPUP_EDGE = 8;

/** Where the popup's top-left corner goes, or null when it should hide.
 *
 * Above the selection when it fits, otherwise below it; when neither fits (a
 * selection taller than the view, or one scrolled partly away) it rests
 * inside the top of the view. Horizontally it is centred on the selection and
 * kept inside the transcript. */
export function placePopup(input: PlacementInput): Placement | null {
  const { selection, bounds, width, height, pin, previous } = input;
  const offscreen =
    selection.bottom <= bounds.top ||
    selection.top >= bounds.bottom ||
    selection.right <= bounds.left ||
    selection.left >= bounds.right;
  if (offscreen && !pin) return null;
  const visible = (edge: number) => edge >= bounds.top && edge <= bounds.bottom;
  const fitsAbove = visible(selection.top) && selection.top - POPUP_GAP - height >= bounds.top + POPUP_EDGE;
  const fitsBelow = visible(selection.bottom) && selection.bottom + POPUP_GAP + height <= bounds.bottom - POPUP_EDGE;
  const side =
    previous === "top" && fitsAbove ? "top"
      : previous === "bottom" && fitsBelow ? "bottom"
        : fitsAbove ? "top"
          : fitsBelow ? "bottom"
            : "inside";
  const centre = (Math.max(selection.left, bounds.left) + Math.min(selection.right, bounds.right)) / 2;
  const maxX = bounds.right - POPUP_EDGE - width;
  const x = Math.max(bounds.left + POPUP_EDGE, Math.min(centre - width / 2, maxX));
  const y =
    side === "top" ? selection.top - POPUP_GAP - height
      : side === "bottom" ? selection.bottom + POPUP_GAP
        // Over the selection's visible top, or at the view's nearer edge
        // while a pinned selection is scrolled away.
        : Math.max(bounds.top + POPUP_EDGE, Math.min(Math.max(selection.top, bounds.top), bounds.bottom - POPUP_EDGE - height));
  return { x, y, side };
}
