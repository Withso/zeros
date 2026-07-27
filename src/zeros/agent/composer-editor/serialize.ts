// ──────────────────────────────────────────────────────────
// serialize.ts — walk the editor doc into ordered segments
// ──────────────────────────────────────────────────────────
//
// One depth-first walk (document order = caret order) produces everything
// the rest of the app needs from the editor:
//   • segments    — text / mention / attachment, in order (sent-bubble inline)
//   • displayText — text + mention tokens, attachments omitted (prompt + title)
//   • attachments — the staged ComposerAttachments in document order, resolved
//     from the hook's side store (the surface builds content blocks from them)
//   • json        — editor.getJSON() for draft / edit-in-place persistence
// ──────────────────────────────────────────────────────────

import type { Editor } from "@tiptap/core";
import type { MessageContentSegment } from "@zeros/core/agent-messages";

import type { ComposerSegment } from "./segments";
import type { ComposerAttachment } from "../composer-attachments";

export interface ComposerSerialized {
  /** No text, no mentions, no attachments → nothing to send. */
  isEmpty: boolean;
  /** editor.getJSON() — round-trippable draft state. */
  json: object;
  /** Prompt text with mention tokens inline; attachments omitted. */
  displayText: string;
  /** Ordered content for inline rendering in the sent bubble. */
  segments: ComposerSegment[];
  /** Staged attachments (with bytes) in document order. */
  attachments: ComposerAttachment[];
}

/** Max base64 length of an image we'll inline as a persisted `thumbnailUri`.
 *  The thumbnail rides the normal message payload into SQLite (and over the
 *  relay on sync), and doubles as the lightbox source, so we keep the full
 *  bytes for typical pasted screenshots but refuse to persist a pathological
 *  multi-MB paste. ~1 MiB of base64 ≈ a ~768 KB image. Above the cap the bubble
 *  shows the attachment pill (name + file icon) with no inline preview; the
 *  full image still rides to the agent as its own content block. (A true
 *  downscale-to-thumbnail is the cleaner future upgrade — this is the cheap,
 *  zero-risk guard.) */
const THUMBNAIL_MAX_BASE64 = 1024 * 1024;

/** Map the composer's serialized segments to the persisted message segments
 *  the sent bubble renders. Drops transient fields (token, attachmentId) and
 *  attaches an image thumbnail (data: URL) so the bubble can show it inline.
 *  Pure — shared by the direct-send + EmptyComposer hand-off paths. */
export function toMessageSegments(
  segments: ComposerSegment[],
  attachments: ComposerAttachment[],
): MessageContentSegment[] {
  return segments.map((s): MessageContentSegment => {
    if (s.type === "text") return { type: "text", text: s.text };
    if (s.type === "mention")
      return { type: "mention", label: s.label, path: s.path, kind: s.kind };
    const att = attachments.find((a) => a.id === s.attachmentId);
    const inlineThumb =
      s.kind === "image" && att && att.data.length <= THUMBNAIL_MAX_BASE64;
    return {
      type: "attachment",
      name: s.name,
      mimeType: s.mimeType,
      kind: s.kind,
      ...(inlineThumb
        ? { thumbnailUri: `data:${att.mimeType};base64,${att.data}` }
        : {}),
    };
  });
}

/** Build a minimal editor doc from plain text — used to seed pre-editor
 *  drafts (which only stored a string) into the TipTap composer. */
export function textToDoc(text: string): object {
  return {
    type: "doc",
    content: [
      text
        ? { type: "paragraph", content: [{ type: "text", text }] }
        : { type: "paragraph" },
    ],
  };
}

function pushText(segs: ComposerSegment[], text: string): void {
  if (!text) return;
  const last = segs[segs.length - 1];
  if (last && last.type === "text") last.text += text;
  else segs.push({ type: "text", text });
}

export function serializeComposer(
  editor: Editor,
  getAttachment: (id: string) => ComposerAttachment | undefined,
): ComposerSerialized {
  const segments: ComposerSegment[] = [];
  const attachments: ComposerAttachment[] = [];
  let firstParagraph = true;

  editor.state.doc.descendants((node) => {
    if (node.isText) {
      pushText(segments, node.text ?? "");
      return false;
    }
    const name = node.type.name;
    if (name === "mention") {
      segments.push({
        type: "mention",
        token: (node.attrs.token as string) || (node.attrs.label as string) || "",
        label: (node.attrs.label as string) || "",
        path: (node.attrs.path as string) || "",
        kind: (node.attrs.kind as "file" | "folder" | "selection") || "file",
      });
      return false;
    }
    if (name === "attachment") {
      const id = node.attrs.attachmentId as string;
      segments.push({
        type: "attachment",
        attachmentId: id,
        name: (node.attrs.name as string) || "",
        mimeType: (node.attrs.mimeType as string) || "",
        kind: (node.attrs.kind as "image" | "text") || "image",
      });
      const att = getAttachment(id);
      if (att) attachments.push(att);
      return false;
    }
    if (name === "paragraph") {
      // Blocks join with a single newline; the first one gets no prefix.
      if (!firstParagraph) pushText(segments, "\n");
      firstParagraph = false;
      return true;
    }
    if (name === "hardBreak") {
      pushText(segments, "\n");
      return false;
    }
    return true;
  });

  let displayText = "";
  for (const s of segments) {
    if (s.type === "text") displayText += s.text;
    else if (s.type === "mention") displayText += s.token;
  }

  const hasAttachment = segments.some((s) => s.type === "attachment");
  const isEmpty = displayText.trim().length === 0 && !hasAttachment;

  return {
    isEmpty,
    json: editor.getJSON(),
    displayText,
    segments,
    attachments,
  };
}
