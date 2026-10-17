import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Fragment, Slice, type Schema } from "@tiptap/pm/model";
import type { LocalLinkScheme } from "@zeros/protocol/local-orchestration";
import { LocalLinkPill } from "../local-links/pill";
import { localLinkSpans } from "../local-links/model";

function LocalLinkNodeView({ node, selected }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" contentEditable={false} data-local-link-node="">
      <LocalLinkPill
        href={String(node.attrs.href ?? "")}
        className={selected ? "ring-highlighted-bright ring-2" : undefined}
      />
    </NodeViewWrapper>
  );
}

/** An editor-only atom. Every text/clipboard/wire path emits the original URL;
 * visibility sharing therefore sees exactly what the human pasted. */
export const LocalLinkNode = Node.create({
  name: "localLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return { href: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "span[data-local-link-node]" }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-local-link-node": "" }),
      node.attrs.href,
    ];
  },
  renderText({ node }) {
    return String(node.attrs.href ?? "");
  },
  addNodeView() {
    return ReactNodeViewRenderer(LocalLinkNodeView);
  },
});

/** A link atom serializes to its raw URL, and a URL runs until whitespace:
 * text typed right against the atom would otherwise become part of it
 * (`…/ws_x` + `what` names another workspace). These say where a separator
 * must be added so the wire and copied text keep each link whole. */
export function linkNeedsSpaceBefore(previous: string): boolean {
  const last = previous.at(-1);
  return last !== undefined && !/[\s([{<"'`]/.test(last);
}

export function textNeedsSpaceAfterLink(next: string): boolean {
  if (!next || /^[\s<>"'`()[\]{}]/.test(next)) return false;
  // Sentence punctuation stays outside the link when a break follows it.
  return !/^[.,;:!?]+(?:[\s)\]}"'`]|$)/.test(next);
}

export function localLinkPasteSlice(
  text: string,
  schema: Schema,
  scheme: LocalLinkScheme,
): Slice | null {
  if (!localLinkSpans(text, scheme).length) return null;
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const children = [];
      let offset = 0;
      for (const span of localLinkSpans(line, scheme)) {
        if (span.start > offset)
          children.push(schema.text(line.slice(offset, span.start)));
        children.push(schema.nodes.localLink.create({ href: span.href }));
        offset = span.end;
      }
      if (offset < line.length) children.push(schema.text(line.slice(offset)));
      return schema.nodes.paragraph.create(null, children);
    });
  return new Slice(Fragment.from(paragraphs), 1, 1);
}
