// A video's key frames and timeline arrive a moment after the video itself.
// They must land beside it, wherever the user has moved it, without cutting
// into what was typed since the drop, and stay their own undo step.
//
// Driven against the REAL AttachmentNode schema, the real
// `insertAttachmentsAfter`, ProseMirror's history plugin and the real
// `serializeComposer`, like composer-attachment-undo.test.ts.

import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/core";

import { AttachmentNode } from "../composer-editor/nodes";
import { insertAttachmentsAfter } from "../composer-editor/use-composer-editor";
import { serializeComposer } from "../composer-editor/serialize";
import type { ComposerAttachment } from "../composer-attachments";

const schema = getSchema([Document, Paragraph, Text, AttachmentNode]);

function attachment(id: string, name: string, mimeType: string): ComposerAttachment {
  return {
    id,
    name,
    mimeType,
    kind: mimeType.startsWith("image/") ? "image" : "file",
    delivery: "reference",
    data: "",
    size: 1,
    validation: { ok: true },
  };
}

const video = attachment("att-video", "clip.mp4", "video/mp4");
const frame = attachment("att-frame", "clip-frame-1.jpg", "image/jpeg");
const timeline = attachment("att-timeline", "clip-timeline.txt", "text/plain");

const videoNode = () =>
  schema.nodes.attachment!.create({
    attachmentId: video.id,
    name: video.name,
    mimeType: video.mimeType,
    kind: "file",
  });

/** The paragraph as `[name]` for each chip and the text between them. */
function pieces(doc: ProseMirrorNode): string[] {
  const out: string[] = [];
  doc.firstChild!.forEach((node) => {
    out.push(node.isText ? node.text! : `[${String(node.attrs.name)}]`);
  });
  return out;
}

/** A composer whose document is `before`, then the video's chip, then
 *  `after`, with the caret at `caret` (default: the end), and the drop that
 *  put the video there as the last history step. */
function composerWithVideo({
  before = "",
  after = " ",
  caret,
}: { before?: string; after?: string; caret?: number } = {}) {
  const store = new Map<string, ComposerAttachment>([[video.id, video]]);
  const empty = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, before ? [schema.text(before)] : []),
  ]);
  let state = EditorState.create({ schema, doc: empty, plugins: [history()] });
  const apply = (tr: Transaction) => {
    state = state.apply(tr);
  };
  // The drop: one transaction, like insertFiles' insertContent.
  const dropAt = 1 + before.length;
  apply(
    state.tr.insert(dropAt, [videoNode(), ...(after ? [schema.text(after)] : [])]),
  );
  const end = state.doc.content.size - 1;
  apply(state.tr.setSelection(TextSelection.create(state.doc, caret ?? end)));

  const ed = {
    get state() {
      return state;
    },
    get isEmpty() {
      return state.doc.firstChild?.content.size === 0;
    },
    getJSON: () => state.doc.toJSON(),
    view: { dispatch: apply },
  } as unknown as Editor;

  return {
    ed,
    store,
    get state() {
      return state;
    },
    type: (text: string) => apply(state.tr.insertText(text)),
    remove: () => {
      let from = -1;
      state.doc.descendants((node, pos) => {
        if (node.attrs.attachmentId === video.id) from = pos;
      });
      apply(state.tr.delete(from, from + 1));
    },
    undo: () => undo(state, apply),
    add: (attachments: ComposerAttachment[]) => {
      for (const a of attachments) store.set(a.id, a);
      return insertAttachmentsAfter(ed, video.id, attachments);
    },
    serialize: () => serializeComposer(ed, (id) => store.get(id)),
  };
}

describe("a video's key frames joining it", () => {
  it("land just past the video and its separator space, in order", () => {
    const c = composerWithVideo();
    expect(c.add([frame, timeline])).toBe(true);
    expect(pieces(c.state.doc)).toEqual([
      "[clip.mp4]",
      " ",
      "[clip-frame-1.jpg]",
      " ",
      "[clip-timeline.txt]",
      " ",
    ]);
    expect(c.serialize().attachments.map((a) => a.name)).toEqual([
      "clip.mp4",
      "clip-frame-1.jpg",
      "clip-timeline.txt",
    ]);
  });

  it("leave the caret after them when it waited right after the video", () => {
    const c = composerWithVideo();
    c.add([frame, timeline]);
    c.type("why");
    expect(pieces(c.state.doc).at(-1)).toBe(" why");
  });

  it("keep what was typed since the drop whole, with the caret in it", () => {
    const c = composerWithVideo({ before: "look ", after: " what broke" });
    c.add([frame]);
    expect(pieces(c.state.doc)).toEqual([
      "look ",
      "[clip.mp4]",
      " ",
      "[clip-frame-1.jpg]",
      " what broke",
    ]);
    c.type("?");
    expect(pieces(c.state.doc).at(-1)).toBe(" what broke?");
  });

  it("leave a caret before the video where it was", () => {
    const c = composerWithVideo({ before: "look ", caret: 3 });
    c.add([frame]);
    c.type("!");
    expect(pieces(c.state.doc)[0]).toBe("lo!ok ");
  });

  it("bring their own separator when the video's is gone", () => {
    const c = composerWithVideo({ after: "" });
    c.add([frame]);
    expect(pieces(c.state.doc)).toEqual(["[clip.mp4]", " ", "[clip-frame-1.jpg]", " "]);
  });

  it("stay out once the user has taken the video out", () => {
    const c = composerWithVideo({ after: " notes" });
    c.remove();
    const before = c.state.doc;
    expect(c.add([frame])).toBe(false);
    expect(c.state.doc.eq(before)).toBe(true);
  });

  it("are their own undo step, however soon they follow the drop", () => {
    const c = composerWithVideo();
    c.add([frame, timeline]);
    expect(c.undo()).toBe(true);
    expect(pieces(c.state.doc)).toEqual(["[clip.mp4]", " "]);
    expect(c.undo()).toBe(true);
    expect(pieces(c.state.doc)).toEqual([]);
  });

  it("don't take typing straight after them into their undo step", () => {
    const c = composerWithVideo();
    c.add([frame]);
    c.type("why");
    expect(c.undo()).toBe(true);
    expect(pieces(c.state.doc)).toEqual(["[clip.mp4]", " ", "[clip-frame-1.jpg]", " "]);
  });
});
