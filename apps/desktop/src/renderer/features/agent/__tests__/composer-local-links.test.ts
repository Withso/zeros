import { describe, expect, it } from "vitest";
import { getSchema, type Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { EditorState, NodeSelection } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import {
  LocalLinkNode,
  localLinkPasteSlice,
} from "../composer-editor/local-link-node";
import { serializeComposer } from "../composer-editor/serialize";
import {
  clipboardPayload,
  prepareClipboardPaste,
} from "../composer-editor/clipboard";

const schema = getSchema([Document, Paragraph, Text, LocalLinkNode]);
const owner = { runtime: "local", cwd: "/repo" };
const raw =
  "Read zeros-dev://chat/child.\nThen zeros-dev://workspace/folder%3Aproject";
function compose() {
  let state = EditorState.create({ schema, plugins: [history()] });
  const slice = localLinkPasteSlice(raw, schema, "zeros-dev")!;
  state = state.apply(
    state.tr.replaceSelection(slice).setMeta("uiEvent", "paste").setTime(1),
  );
  const editor = {
    get state() {
      return state;
    },
    getJSON: () => state.doc.toJSON(),
  } as Editor;
  return {
    editor,
    get state() {
      return state;
    },
    dispatch: (tr: EditorState["tr"]) => {
      state = state.apply(tr);
    },
  };
}

function editorOf(content: object[]) {
  const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content }] });
  const state = EditorState.create({ schema, doc });
  return { editor: { state, getJSON: () => state.doc.toJSON() } as Editor, state };
}

const link = (href: string) => ({ type: "localLink", attrs: { href } });

describe("Local link atoms keep their links whole", () => {
  it("separates text typed right against a pasted link (the user's 'russetwhat')", () => {
    const { editor, state } = editorOf([
      { type: "text", text: "send hi to this" },
      link("zeros-dev://chat/chat-mvbyw4sx-nx6o"),
      { type: "text", text: "chat tab" },
    ]);
    expect(serializeComposer(editor, () => undefined).displayText).toBe(
      "send hi to this zeros-dev://chat/chat-mvbyw4sx-nx6o chat tab",
    );
    const leading = editorOf([link("zeros-dev://workspace/ws_c952b2-russet"), { type: "text", text: "what does it do?" }]);
    expect(serializeComposer(leading.editor, () => undefined).displayText).toBe(
      "zeros-dev://workspace/ws_c952b2-russet what does it do?",
    );
    // Copying the same content keeps the boundary too.
    expect(
      clipboardPayload({ content: state.doc.toJSON().content, openStart: 0, openEnd: 0 }, () => undefined, owner).text,
    ).toBe("send hi to this zeros-dev://chat/chat-mvbyw4sx-nx6o chat tab");
  });

  it("adds nothing where a separator or sentence punctuation is already there", () => {
    for (const [content, expected] of [
      [[{ type: "text", text: "see " }, link("zeros-dev://chat/a"), { type: "text", text: " now" }], "see zeros-dev://chat/a now"],
      [[{ type: "text", text: "see (" }, link("zeros-dev://chat/a"), { type: "text", text: ")." }], "see (zeros-dev://chat/a)."],
      [[{ type: "text", text: "see " }, link("zeros-dev://chat/a"), { type: "text", text: "." }], "see zeros-dev://chat/a."],
      [[{ type: "text", text: "see " }, link("zeros-dev://chat/a"), { type: "text", text: ", then" }], "see zeros-dev://chat/a, then"],
      [[link("zeros-dev://chat/a"), link("zeros-dev://chat/b")], "zeros-dev://chat/a zeros-dev://chat/b"],
    ] as const) {
      const { editor } = editorOf([...content]);
      expect(serializeComposer(editor, () => undefined).displayText).toBe(expected);
    }
  });
});

describe("Local link composer atoms", () => {
  it("pastes inline atoms but keeps raw links in displayText and every wire segment", () => {
    const { editor, state } = compose();
    const serialized = serializeComposer(editor, () => undefined);
    expect(serialized.displayText).toBe(raw);
    expect(serialized.segments).toEqual([{ type: "text", text: raw }]);
    expect(
      JSON.stringify(state.doc.toJSON()).match(/"type":"localLink"/g),
    ).toHaveLength(2);
    expect(serialized.attachments).toEqual([]);
    expect(serialized.isEmpty).toBe(false);
    const restored = schema.nodeFromJSON(serialized.json);
    expect(restored.eq(state.doc)).toBe(true);
  });

  it("copies raw URLs and retains local clipboard atoms across paste", () => {
    const { state } = compose();
    const content = state.doc.toJSON().content;
    const payload = clipboardPayload(
      { content, openStart: 0, openEnd: 0 },
      () => undefined,
      owner,
    );
    expect(payload.text).toBe(raw);
    const pasted = prepareClipboardPaste(payload, owner)!;
    expect(pasted.slice.content).toEqual(content);
    const cloudPaste = prepareClipboardPaste(payload, {
      runtime: "cloud:org/workspace",
      cwd: "/repo",
    })!;
    expect(JSON.stringify(cloudPaste.slice.content)).not.toContain(
      '"type":"localLink"',
    );
    expect(JSON.stringify(cloudPaste.slice.content)).toContain(
      "zeros-dev://chat/child",
    );
  });

  it("deletes the entire atom and restores it on undo with its exact raw link", () => {
    const composer = compose();
    let position = -1;
    composer.state.doc.descendants((node, pos) => {
      if (node.type.name === "localLink" && position < 0) position = pos;
    });
    composer.dispatch(
      composer.state.tr
        .setSelection(NodeSelection.create(composer.state.doc, position))
        .deleteSelection()
        .setTime(1_000),
    );
    expect(
      serializeComposer(composer.editor, () => undefined).displayText,
    ).not.toContain("zeros-dev://chat/child");
    expect(undo(composer.state, composer.dispatch)).toBe(true);
    // A user delete is a distinct history event from the paste.
    expect(
      serializeComposer(composer.editor, () => undefined).displayText,
    ).toBe(raw);
  });

  it("ignores foreign/malformed links and rejects forged clipboard atoms", () => {
    expect(
      localLinkPasteSlice("zeros-beta://chat/child", schema, "zeros-dev"),
    ).toBeNull();
    expect(
      localLinkPasteSlice(
        "zeros-dev://chat/child?run=true",
        schema,
        "zeros-dev",
      ),
    ).toBeNull();
    const payload = clipboardPayload(
      {
        content: [
          { type: "localLink", attrs: { href: "javascript:alert(1)" } },
        ],
        openStart: 0,
        openEnd: 0,
      },
      () => undefined,
      owner,
    );
    expect(prepareClipboardPaste(payload, owner)).toBeNull();
  });
});
