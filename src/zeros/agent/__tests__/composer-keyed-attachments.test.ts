// The keyed-attachment contract the transcript pills depend on.
//
// The load-bearing claim in chat-transcript-pills.tsx is that the composer
// DOCUMENT is the single source of truth for "is this chat attached" — which
// is what makes removing a chip with its × un-add the pill, with no second
// list to drift. These tests pin the read side of that.
//
// Built against the REAL AttachmentNode schema (via TipTap's getSchema, which
// needs no DOM) rather than a hand-rolled stand-in, so a rename or a dropped
// attr fails here rather than at runtime. The editor itself can't be
// instantiated — vitest runs in the node environment and TipTap's Editor wants
// a window — which is exactly why the position math lives in a pure module.

import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import { AttachmentNode } from "../composer-editor/nodes";
import {
  collectSourceKeys,
  findAttachmentsBySourceKey,
} from "../composer-editor/attachment-keys";

const schema = getSchema([Document, Paragraph, Text, AttachmentNode]);

type Piece = { text: string } | { id: string; name: string; key?: string };

/** Build a one-paragraph doc from a mix of text and attachment atoms. */
function doc(...pieces: Piece[]): ProseMirrorNode {
  const nodes = pieces.map((p) =>
    "text" in p
      ? schema.text(p.text)
      : schema.nodes.attachment.create({
          attachmentId: p.id,
          name: p.name,
          mimeType: "text/plain",
          kind: "text",
          sourceKey: p.key ?? "",
        }),
  );
  return schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, nodes),
  ]);
}

describe("the attachment node carries a sourceKey", () => {
  it("defaults to empty — a pasted / dropped / picked file has no caller identity", () => {
    expect(schema.nodes.attachment.spec.attrs?.sourceKey).toEqual({
      default: "",
    });
  });

  it("is not confused with attachmentId", () => {
    // Two different keys: one addresses the bytes in the side store, the other
    // is the caller's identity for replace + remove. Collapsing them would
    // make "switch this transcript to full" impossible to express.
    const d = doc({ id: "att-1", name: "x.txt", key: "transcript:c1" });
    const [hit] = findAttachmentsBySourceKey(d, "transcript:c1");
    expect(hit.attachmentId).toBe("att-1");
  });
});

describe("collectSourceKeys", () => {
  it("returns nothing for a document of plain files", () => {
    expect(
      collectSourceKeys(
        doc({ id: "a", name: "shot.png" }, { id: "b", name: "notes.md" }),
      ),
    ).toEqual([]);
  });

  it("returns keys in document order", () => {
    expect(
      collectSourceKeys(
        doc(
          { id: "a", name: "one.txt", key: "transcript:c1" },
          { text: " and " },
          { id: "b", name: "shot.png" },
          { id: "c", name: "two.txt", key: "transcript:c2" },
        ),
      ),
    ).toEqual(["transcript:c1", "transcript:c2"]);
  });

  it("survives text before, between and after the atoms", () => {
    expect(
      collectSourceKeys(
        doc(
          { text: "compare " },
          { id: "a", name: "one.txt", key: "transcript:c1" },
          { text: " with " },
          { id: "b", name: "two.txt", key: "transcript:c2" },
          { text: " please" },
        ),
      ),
    ).toEqual(["transcript:c1", "transcript:c2"]);
  });
});

describe("findAttachmentsBySourceKey", () => {
  it("finds nothing for a key that isn't staged", () => {
    expect(
      findAttachmentsBySourceKey(doc({ id: "a", name: "x.png" }), "transcript:c1"),
    ).toEqual([]);
  });

  it("returns the node's exact span", () => {
    // An atom is one position wide, and the paragraph opens at 0, so the node
    // sits at 1..2. If this drifts, a delete eats a neighbouring character.
    const hits = findAttachmentsBySourceKey(
      doc({ id: "a", name: "x.txt", key: "transcript:c1" }),
      "transcript:c1",
    );
    expect(hits).toEqual([{ from: 1, to: 2, attachmentId: "a" }]);
  });

  it("swallows the separator space the insert put after the node", () => {
    // Regression: attach then un-attach used to leave an invisible space, so
    // the composer reported itself non-empty — placeholder hidden, Send
    // apparently enabled — while handleSend early-returns on an empty trimmed
    // prompt, so Enter did nothing with no feedback. One pill click each way
    // is a one-gesture round trip, and every one added another space.
    const hits = findAttachmentsBySourceKey(
      doc({ id: "a", name: "x.txt", key: "transcript:c1" }, { text: " " }),
      "transcript:c1",
    );
    expect(hits).toEqual([{ from: 1, to: 3, attachmentId: "a" }]);
  });

  it("takes only ONE space, and never the user's own text", () => {
    // "  hello" after the chip must keep " hello" — eating more than the one
    // separator would silently edit what the user typed.
    expect(
      findAttachmentsBySourceKey(
        doc({ id: "a", name: "x.txt", key: "transcript:c1" }, { text: "  hi" }),
        "transcript:c1",
      )[0].to,
    ).toBe(3);
    // A chip followed immediately by non-space text keeps its bare span.
    expect(
      findAttachmentsBySourceKey(
        doc({ id: "a", name: "x.txt", key: "transcript:c1" }, { text: "hi" }),
        "transcript:c1",
      )[0].to,
    ).toBe(2);
  });

  it("ignores attachments belonging to other chats", () => {
    const hits = findAttachmentsBySourceKey(
      doc(
        { id: "a", name: "one.txt", key: "transcript:c1" },
        { id: "b", name: "two.txt", key: "transcript:c2" },
      ),
      "transcript:c2",
    );
    expect(hits.map((h) => h.attachmentId)).toEqual(["b"]);
  });

  it("orders hits HIGHEST POSITION FIRST", () => {
    // The load-bearing property. Every delete shifts the positions after it,
    // so a caller deleting front-to-back with positions collected up front
    // would cut the wrong range from the second hit onwards — silently
    // mangling the prompt. Duplicates shouldn't occur (insert replaces
    // first), but the ordering is what makes the code safe if one ever does.
    const hits = findAttachmentsBySourceKey(
      doc(
        { id: "first", name: "a.txt", key: "transcript:c1" },
        { text: "xx" },
        { id: "second", name: "b.txt", key: "transcript:c1" },
      ),
      "transcript:c1",
    );
    expect(hits.map((h) => h.attachmentId)).toEqual(["second", "first"]);
    expect(hits[0].from).toBeGreaterThan(hits[1].from);
  });

  it("refuses the empty key instead of matching every plain file", () => {
    // "" is the DEFAULT sourceKey, so without the guard a caller whose chatId
    // was empty would delete every attachment in the composer rather than
    // doing nothing. Worst possible failure mode for a remove path.
    expect(
      findAttachmentsBySourceKey(
        doc({ id: "a", name: "shot.png" }, { id: "b", name: "notes.md" }),
        "",
      ),
    ).toEqual([]);
    expect(
      findAttachmentsBySourceKey(
        doc({ id: "a", name: "x.txt", key: "transcript:c1" }),
        "",
      ),
    ).toEqual([]);
  });
});
