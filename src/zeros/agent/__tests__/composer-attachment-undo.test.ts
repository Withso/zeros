// Removing a staged attachment must stay UNDOABLE in full.
//
// The composer keeps attachment bytes in a side store and only an id in the
// document, so the two can fall out of step in one direction: the node
// deletion rides ProseMirror's history and comes back on ⌘Z, but a Map
// eviction does not. A removal that evicted the bytes therefore restored a
// chip that resolved to nothing — and `serializeComposer` drops an attachment
// it cannot look up while still emitting its segment, so the send omitted the
// file with the sent bubble still drawing the chip. Nothing reported it: the
// attachment never reached `encodeAttachments`, so not even its `skipped`
// channel could speak.
//
// Driven against the REAL AttachmentNode schema, the real `removeBySourceKey`
// and the real `serializeComposer`. No DOM: ProseMirror's EditorState and
// history plugin are both pure, and only EditorView wants a window — which is
// what makes the undo round trip observable here at all.

import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { EditorState } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import type { Editor } from "@tiptap/core";

import { AttachmentNode } from "../composer-editor/nodes";
import { removeBySourceKey } from "../composer-editor/use-composer-editor";
import { serializeComposer } from "../composer-editor/serialize";
import { collectSourceKeys } from "../composer-editor/attachment-keys";
import type { ComposerAttachment } from "../composer-attachments";

const schema = getSchema([Document, Paragraph, Text, AttachmentNode]);

function attachment(id: string, name: string, text: string): ComposerAttachment {
  return {
    id,
    name,
    mimeType: "text/plain",
    kind: "text",
    data: "",
    text,
    size: text.length,
    validation: { ok: true },
  } as ComposerAttachment;
}

/** A composer holding one text chip staged under `sourceKey`, plus the side
 *  store that carries its bytes. */
function stagedComposer(sourceKey: string) {
  const att = attachment("att-X", "cream.concise.txt", "# Cream\n\nthe body");
  const store = new Map<string, ComposerAttachment>([[att.id, att]]);
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, [
      schema.text("look at "),
      schema.nodes.attachment.create({
        attachmentId: att.id,
        name: att.name,
        mimeType: att.mimeType,
        kind: "text",
        sourceKey,
      }),
    ]),
  ]);

  // `history()` is what makes this a regression test rather than a shape
  // check — it is the same plugin the composer's UndoRedo extension installs.
  let state = EditorState.create({ schema, doc, plugins: [history()] });

  // Between them, removeBySourceKey and serializeComposer touch only these:
  // state.doc / state.tr, view.dispatch, getJSON() and isEmpty. Everything
  // here is a thin pass-through to the real EditorState, so the code under
  // test runs unmodified.
  const ed = {
    get state() {
      return state;
    },
    get isEmpty() {
      const { doc } = state;
      return doc.childCount === 1 && doc.firstChild?.content.size === 0;
    },
    getJSON: () => state.doc.toJSON(),
    view: {
      dispatch: (tr: ReturnType<EditorState["tr"]["setMeta"]>) => {
        state = state.apply(tr as never);
      },
    },
  } as unknown as Editor;

  return {
    ed,
    store,
    get state() {
      return state;
    },
    undo: () => undo(state, (tr) => (state = state.apply(tr))),
    serialize: () => serializeComposer(ed, (id) => store.get(id)),
  };
}

describe("removing a staged attachment", () => {
  it("takes the node out of the document", () => {
    const c = stagedComposer("transcript:c1");
    expect(removeBySourceKey(c.ed, "transcript:c1")).toBe(true);
    expect(collectSourceKeys(c.state.doc)).toEqual([]);
    expect(c.serialize().attachments).toEqual([]);
  });

  it("leaves the bytes in the side store", () => {
    // The removal is undoable; the eviction would not have been. Keeping the
    // bytes is what lets the restored chip resolve.
    const c = stagedComposer("transcript:c1");
    removeBySourceKey(c.ed, "transcript:c1");
    expect(c.store.has("att-X")).toBe(true);
  });

  it("restores a SENDABLE chip on undo, not an empty one", () => {
    const c = stagedComposer("transcript:c1");
    removeBySourceKey(c.ed, "transcript:c1");
    expect(c.undo()).toBe(true);

    // The chip is back in the document…
    expect(collectSourceKeys(c.state.doc)).toEqual(["transcript:c1"]);

    // …and, the part that actually regressed, it still carries its bytes.
    // Before the fix this array was empty while the segment below was not —
    // a chip the user could see attached to a prompt the agent never got.
    const out = c.serialize();
    expect(out.attachments.map((a) => a.id)).toEqual(["att-X"]);
    expect(out.attachments[0]?.text).toContain("the body");
    expect(
      out.segments.filter((s) => s.type === "attachment"),
    ).toHaveLength(1);
  });

  it("keeps document and store in step across a replace-in-place swap", () => {
    // Attaching the FULL transcript of a chat whose concise one is staged goes
    // through the same removal, so the same undo hazard applies to the swap.
    const c = stagedComposer("transcript:c1");
    removeBySourceKey(c.ed, "transcript:c1");
    expect(c.undo()).toBe(true);
    expect(c.serialize().attachments).toHaveLength(1);
  });

  it("is a no-op for a key that is not staged", () => {
    const c = stagedComposer("transcript:c1");
    expect(removeBySourceKey(c.ed, "transcript:other")).toBe(false);
    expect(collectSourceKeys(c.state.doc)).toEqual(["transcript:c1"]);
    expect(c.store.has("att-X")).toBe(true);
  });
});
