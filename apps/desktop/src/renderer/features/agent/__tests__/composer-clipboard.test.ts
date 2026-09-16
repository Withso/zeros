import { expect, it } from "vitest";
import {
  clipboardPayload,
  prepareClipboardPaste,
  readComposerClipboardHtml,
} from "../composer-editor/clipboard";
import type { ComposerAttachment } from "../composer-attachments";
const owner = { runtime: "local", cwd: "/repo" };
const attachment: ComposerAttachment = {
  id: "att-1",
  contextAttachmentId: "record-1",
  name: "data.jsonl",
  mimeType: "application/jsonl",
  kind: "file",
  size: 12,
  data: "",
  delivery: "reference",
  validation: { ok: true },
  diskPath: ".context/local/attachments/record-1/data.jsonl",
  owner,
};
const slice = {
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "read " },
        {
          type: "attachment",
          attrs: { attachmentId: "att-1", name: attachment.name, kind: "file" },
        },
        { type: "text", text: " please" },
      ],
    },
  ],
  openStart: 1,
  openEnd: 1,
};

it("reads HTML clipboard metadata as data without a browser DOM", () => {
  const payload = clipboardPayload(slice, () => attachment, owner);
  const encoded = JSON.stringify(payload);
  const attribute = encoded
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  const html = `<div data-zeros-composer="${attribute}"><img src="https://example.test/clipboard.png" onerror="alert(1)"><script>alert(1)</script></div>`;

  const extracted = readComposerClipboardHtml(html);
  expect(extracted).toBe(encoded);
  expect(
    prepareClipboardPaste(JSON.parse(extracted), owner)?.attachments[0],
  ).toMatchObject({ contextAttachmentId: "record-1", owner });
});

it("extracts the first real clipboard marker and decodes attribute entities", () => {
  expect(
    readComposerClipboardHtml(
      `<script>const marker = '<div data-zeros-composer="fake">';</script><!-- <div data-zeros-composer="comment"> --><section><span DATA-ZEROS-COMPOSER='&quot;first &amp; &#39;value&#39;&quot;'></span></section><div data-zeros-composer="second"></div>`,
    ),
  ).toBe("\"first & 'value'\"");
});

it("ignores clipboard markers inside template contents", () => {
  expect(
    readComposerClipboardHtml(
      '<template><div data-zeros-composer="hidden"></div></template><div data-zeros-composer="visible"></div>',
    ),
  ).toBe("visible");
});

it.each([
  '<!doctype html><html data-zeros-composer="metadata"><body></body></html>',
  '<!doctype html><html><body data-zeros-composer="metadata"></body></html>',
  '<noscript><div data-zeros-composer="metadata"></div></noscript>',
])("keeps inert document parsing for %s", (html) => {
  expect(readComposerClipboardHtml(html)).toBe("metadata");
});

it("rejects missing or oversized HTML clipboard metadata", () => {
  expect(readComposerClipboardHtml("<div>ordinary HTML</div>")).toBe("");
  expect(
    readComposerClipboardHtml(
      `<div data-zeros-composer="${"x".repeat(2_000_000)}"></div>`,
    ),
  ).toBe("");
});

it("rehydrates same-workspace references with fresh node ids and the same durable file", () => {
  const payload = clipboardPayload(slice, () => attachment, owner);
  const pasted = prepareClipboardPaste(payload, owner)!;
  expect(pasted.attachments).toHaveLength(1);
  expect(pasted.attachments[0]).toMatchObject({
    contextAttachmentId: "record-1",
    diskPath: attachment.diskPath,
    owner,
  });
  expect(pasted.attachments[0].id).not.toBe(attachment.id);
  expect(pasted.slice.content[0].content![1].attrs!.attachmentId).toBe(
    pasted.attachments[0].id,
  );
  expect(payload.text).toBe(
    "read /repo/.context/local/attachments/record-1/data.jsonl please",
  );
});

it("uses plain full source paths across workspaces, including different remote hosts", () => {
  const payload = clipboardPayload(slice, () => attachment, owner);
  const pasted = prepareClipboardPaste(payload, {
    runtime: "local",
    cwd: "/other",
  })!;
  expect(pasted.attachments).toEqual([]);
  expect(JSON.stringify(pasted.slice)).not.toContain('"type":"attachment"');
  expect(pasted.slice.content[0].content![1].text).toBe(
    "/repo/.context/local/attachments/record-1/data.jsonl",
  );
  const remote = { runtime: "cloud:org:workspace", cwd: "/repo" };
  const remotePayload = clipboardPayload(
    slice,
    () => ({ ...attachment, owner: remote }),
    remote,
  );
  expect(
    prepareClipboardPaste(remotePayload, owner)!.slice.content[0].content![1]
      .text,
  ).toContain("cloud:org:workspace");
});

it("copies only selected metadata, preserves pending recovery, and excludes file bytes", () => {
  const payload = clipboardPayload(
    slice,
    () => ({
      ...attachment,
      sourceRecoveryId: "recover",
      sourceFile: new Blob(["secret"]),
      data: "secret",
      text: "secret",
    }),
    owner,
  );
  expect(JSON.stringify(payload)).not.toContain("secret");
  expect(
    prepareClipboardPaste(payload, owner)!.attachments[0].sourceRecoveryId,
  ).toBe("recover");
  expect(prepareClipboardPaste({ ...payload, version: 999 }, owner)).toBeNull();
});

it("keeps an unresolved visible pill in the send input instead of dropping it", () => {
  const payload = clipboardPayload(slice, () => undefined, owner);
  const pasted = prepareClipboardPaste(payload, owner)!;
  expect(pasted.attachments[0].unavailable).toBe(true);
});

it("rejects forged preview objects and source keys from clipboard HTML", () => {
  const payload = clipboardPayload(slice, () => attachment, owner);
  payload.attachments[0].preview = {
    agentName: { html: "untrusted" },
  } as never;
  expect(prepareClipboardPaste(payload, owner)).toBeNull();
  delete payload.attachments[0].preview;
  payload.attachments[0].sourceKey = { key: "untrusted" } as never;
  expect(prepareClipboardPaste(payload, owner)).toBeNull();
});

it("retains an unsaved legacy text attachment when copying its pill", () => {
  const legacy: ComposerAttachment = {
    ...attachment,
    delivery: undefined,
    kind: "text",
    text: "unsaved legacy body",
    diskPath: undefined,
    contextAttachmentId: undefined,
  };
  const payload = clipboardPayload(slice, () => legacy, owner);
  expect(payload.attachments[0].sourceRecoveryId).toBeTruthy();
  expect(payload.attachments[0].size).toBe(
    new TextEncoder().encode(legacy.text).length,
  );
  expect(JSON.stringify(payload)).not.toContain("unsaved legacy body");
});

it("copies a saved legacy text reference without turning its placeholder into a recovery source", () => {
  const legacy: ComposerAttachment = {
    ...attachment,
    delivery: undefined,
    kind: "text",
    text: "",
    diskPath: undefined,
  };
  const payload = clipboardPayload(slice, () => legacy, owner);
  expect(payload.attachments[0].contextAttachmentId).toBe("record-1");
  expect(payload.attachments[0].sourceRecoveryId).toBeUndefined();
  expect(legacy.sourceFile).toBeUndefined();
});
