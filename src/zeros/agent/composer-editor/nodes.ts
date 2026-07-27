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
