// ──────────────────────────────────────────────────────────
// nodes.ts — custom atomic inline nodes (mention + attachment)
// ──────────────────────────────────────────────────────────
//
// Both are `group:'inline' inline:true atom:true` so they sit in the text
// flow as single, Backspace-deletable units rendered by a React NodeView
// pill. renderText controls what editor.getText() emits:
//   • mention     → its backtick path token / "@selection" (rides in the prompt)
//   • attachment  → "" (rides as a content block, not prompt text)
// ──────────────────────────────────────────────────────────

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";

import { MentionPill, AttachmentPill } from "./pills";

export const MentionNode = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      token: { default: "" },
      label: { default: "" },
      path: { default: "" },
      kind: { default: "file" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-mention]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-mention": "",
        "data-token": node.attrs.token,
        "data-path": node.attrs.path,
        "data-kind": node.attrs.kind,
        "data-label": node.attrs.label,
      }),
      node.attrs.label,
    ];
  },

  // Plain-text serialization: the backtick path token (or "@selection").
  renderText({ node }) {
    return node.attrs.token || node.attrs.label || "";
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionPill);
  },
});

export const AttachmentNode = Node.create({
  name: "attachment",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      // Key into the editor hook's side store (the bytes live there, not
      // in the doc, so getJSON() drafts stay small).
      attachmentId: { default: "" },
      name: { default: "" },
      mimeType: { default: "" },
      kind: { default: "image" },
      // Caller-owned identity for a SYNTHESIZED attachment — today only chat
      // transcripts, as `transcript:<chatId>` (transcriptSourceKey). Empty for
      // anything the user pasted, dropped or picked.
      //
      // The mode is deliberately NOT in the key: one chat contributes at most
      // one attachment, so choosing "Attach full" for a chat whose concise
      // transcript is already staged REPLACES that chip rather than adding a
      // rival. Putting `:<mode>` here would give the two modes distinct keys
      // and quietly turn the swap into a second chip.
      //
      // It lives on the node rather than beside it because the doc is the only
      // source of truth for what is staged: the transcript pill reads this to
      // decide whether it is "added", so removing the chip with × un-adds the
      // pill for free, with no second list to keep in sync.
      sourceKey: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-attachment]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-attachment": "",
        "data-attachment-id": node.attrs.attachmentId,
        "data-name": node.attrs.name,
        "data-mime": node.attrs.mimeType,
        "data-kind": node.attrs.kind,
        "data-source-key": node.attrs.sourceKey,
      }),
      node.attrs.name,
    ];
  },

  // Attachments contribute nothing to the prompt string — they ride as
  // ordered content blocks built from the serialized segments.
  renderText() {
    return "";
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentPill);
  },
});
