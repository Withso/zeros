import { describe, expect, it } from "vitest";
import { getSchema, type Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { EditorState } from "@tiptap/pm/state";
import { AttachmentNode } from "../composer-editor/nodes";
import { collectAttachmentIds } from "../composer-editor/attachment-keys";
import {
  serializeComposer,
  toMessageSegments,
} from "../composer-editor/serialize";
import { messageToEditorContent } from "../composer-editor/reconstruct";
import {
  clipboardPayload,
  prepareClipboardPaste,
} from "../composer-editor/clipboard";
import { planSeedStage } from "../composer-editor/context-graph-staging";
import type { ComposerAttachment } from "../composer-attachments";
import {
  attachmentNodeContent,
  attachmentNodeIds,
  MAX_ATTACHMENT_GROUP_FILES,
} from "../composer-editor/attachment-group";

const schema = getSchema([Document, Paragraph, Text, AttachmentNode]);
const files: ComposerAttachment[] = [
  ["frame.jpg", "image/jpeg"],
  ["timeline.txt", "text/plain"],
  ["report.pdf", "application/pdf"],
].map(([name, mimeType], index) => ({
  id: `att-${index}`,
  name,
  mimeType,
  kind: mimeType.startsWith("image/") ? "image" : "file",
  data: "",
  size: 12,
  delivery: "reference",
  validation: { ok: true },
  diskPath: `.context/attachments/att-${index}/${name}`,
}));
const owner = { runtime: "local", cwd: "/repo" };
function fixture() {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Review " },
          {
            type: "attachment",
            attrs: {
              attachmentId: files[0].id,
              attachmentIds: files.map((file) => file.id),
              groupId: "group-1",
              name: "Clip frames",
              mimeType: files[0].mimeType,
              kind: files[0].kind,
            },
          },
          { type: "text", text: " please" },
        ],
      },
    ],
  });
  const editor = {
    state: EditorState.create({ schema, doc }),
    getJSON: () => doc.toJSON(),
  } as Editor;
  return {
    doc,
    editor,
    lookup: (id: string) => files.find((file) => file.id === id),
  };
}

describe("attachment groups are presentation over independent files", () => {
  it("bounds restored membership, including a separate primary id", () => {
    expect(
      attachmentNodeIds({
        attachmentId: "primary",
        attachmentIds: Array.from(
          { length: MAX_ATTACHMENT_GROUP_FILES },
          (_, index) => `file-${index}`,
        ),
      }),
    ).toHaveLength(MAX_ATTACHMENT_GROUP_FILES);
  });

  it("retains very large selections in bounded groups without losing files", () => {
    const files = Array.from(
      { length: 1001 },
      (_, index) =>
        ({
          id: `file-${index}`,
          name: `file-${index}.txt`,
          kind: "file",
          mimeType: "text/plain",
        }) as ComposerAttachment,
    );
    const nodes = attachmentNodeContent(files).filter(
      (node) => node.type === "attachment",
    );
    expect(nodes).toHaveLength(2);
    expect(nodes.flatMap((node) => attachmentNodeIds(node.attrs!))).toEqual(
      files.map((file) => file.id),
    );
  });
  it("stages and sends every group member in order while keeping one editor atom", () => {
    const { doc, editor, lookup } = fixture();
    expect(doc.firstChild!.childCount).toBe(3);
    expect(collectAttachmentIds(doc)).toEqual(files.map((file) => file.id));
    expect(planSeedStage(collectAttachmentIds(doc), lookup).stage).toEqual(
      files,
    );
    const result = serializeComposer(editor, lookup);
    expect(result.displayText).toBe("Review  please");
    expect(result.attachments).toEqual(files);
    const segments = toMessageSegments(
      result.segments,
      files,
      new Map(
        files.map((file) => [
          file.id,
          {
            diskPath: file.diskPath,
            attachmentId: file.id,
            delivery: "reference",
            size: file.size,
          },
        ]),
      ),
    );
    expect(
      segments.filter((segment) => segment.type === "attachment"),
    ).toMatchObject(
      files.map((file) => ({
        name: file.name,
        diskPath: file.diskPath,
        group: { id: "group-1", name: "Clip frames" },
      })),
    );
    const restored = messageToEditorContent({
      text: result.displayText,
      segments,
    });
    const restoredDoc = schema.nodeFromJSON(restored.json);
    expect(restoredDoc.firstChild!.childCount).toBe(3);
    expect(restored.attachments.map((file) => file.diskPath)).toEqual(
      files.map((file) => file.diskPath),
    );
    expect(collectAttachmentIds(restoredDoc)).toEqual(
      restored.attachments.map((file) => file.id),
    );
  });

  it("copies all members, remaps the group on same-owner paste, and preserves foreign paths", () => {
    const { doc, lookup } = fixture();
    const payload = clipboardPayload(
      { content: doc.toJSON().content, openStart: 0, openEnd: 0 },
      lookup,
      owner,
    );
    expect(payload.attachments.map((file) => file.id)).toEqual(
      files.map((file) => file.id),
    );
    const pasted = prepareClipboardPaste(payload, owner)!;
    expect(pasted.attachments).toHaveLength(3);
    expect(new Set(pasted.attachments.map((file) => file.id)).size).toBe(3);
    const pastedDoc = schema.nodeFromJSON({
      type: "doc",
      content: pasted.slice.content,
    });
    expect(collectAttachmentIds(pastedDoc)).toEqual(
      pasted.attachments.map((file) => file.id),
    );
    expect(pastedDoc.firstChild!.child(1).attrs.groupId).not.toBe("group-1");
    const foreign = prepareClipboardPaste(payload, {
      runtime: "cloud:other",
      cwd: "cloud://other",
    })!;
    expect(foreign.attachments).toHaveLength(0);
    for (const file of files)
      expect(JSON.stringify(foreign.slice)).toContain(file.diskPath);
  });

  it("does not silently drop a missing group member", () => {
    const { editor, lookup } = fixture();
    const result = serializeComposer(editor, (id) =>
      id === files[1].id ? undefined : lookup(id),
    );
    expect(result.attachments).toHaveLength(3);
    expect(result.attachments[1]).toMatchObject({
      id: files[1].id,
      unavailable: true,
    });
  });
});
