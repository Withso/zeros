import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const transport = vi.hoisted(() => ({
  write: vi.fn(),
  readImage: vi.fn(),
  readText: vi.fn(),
}));
vi.mock("../agent-history-client", () => ({
  createContextAttachmentWriter: () => transport.write,
  writeContextAttachment: transport.write,
  readImageAttachment: transport.readImage,
  readTextAttachment: transport.readText,
}));
import {
  transferContextAttachment,
  resetAttachmentTransfersForTests,
} from "../../../../engine/files/attachment-transfer";
import { setContextGraphAttachmentShared } from "../../../../engine/files/context-graph";
import { encodeAttachments } from "../encode-attachments";
import { messageToEditorContent } from "../composer-editor/reconstruct";
import { resetFileAttachmentTransfersForTests } from "../file-attachment-transfer";
import type { ComposerAttachment } from "../composer-attachments";
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-reference-encoder-"));
  resetFileAttachmentTransfersForTests();
  transport.write
    .mockReset()
    .mockImplementation((args) => transferContextAttachment(root, args));
  transport.readImage.mockReset();
  transport.readText.mockReset();
});
afterEach(async () => {
  await resetAttachmentTransfersForTests();
  await fs.rm(root, { recursive: true, force: true });
});
const textAttachment = (
  over: Partial<ComposerAttachment> = {},
): ComposerAttachment => ({
  id: "att-text",
  name: "notes.txt",
  mimeType: "text/plain",
  size: 0,
  kind: "text",
  data: "",
  text: "héllo\r\n",
  validation: { ok: true },
  ...over,
});
const context = (agentId: string) => ({
  cwd: root,
  supportsImage: true,
  chatId: null,
  agentId,
});

it.each(["claude", "codex", "cursor", "custom"])(
  "delivers legacy text and image bytes only as confirmed file references to %s",
  async (agent) => {
    const image = textAttachment({
      id: "att-image",
      kind: "image",
      name: "screen.png",
      mimeType: "image/png",
      text: undefined,
      data: "AAECA/8=",
    });
    const result = await encodeAttachments(
      [textAttachment(), image],
      context(agent),
    );
    expect(result.blocks).toHaveLength(2);
    expect(
      result.blocks.every(
        (block) =>
          block.type === "text" && block.text.startsWith("<attached_file "),
      ),
    ).toBe(true);
    expect(JSON.stringify(result.blocks)).not.toContain("héllo");
    expect(JSON.stringify(result.blocks)).not.toContain("AAECA/8=");
    const paths = result.bubbleAttachments.map((a) =>
      path.join(root, a.diskPath!),
    );
    expect(await fs.readFile(paths[0], "utf8")).toBe("héllo\r\n");
    expect(await fs.readFile(paths[1])).toEqual(Buffer.from([0, 1, 2, 3, 255]));
    const edited = messageToEditorContent({
      text: "again",
      attachments: result.bubbleAttachments,
    });
    transport.write.mockClear();
    expect(
      (await encodeAttachments(edited.attachments, context(agent))).blocks,
    ).toEqual(result.blocks);
    expect(
      transport.write.mock.calls.every(([args]) => args.resolve === true),
    ).toBe(true);
    expect(transport.readText).not.toHaveBeenCalled();
    expect(transport.readImage).not.toHaveBeenCalled();
  },
);

it("saves empty files and preserves metadata through repeated edits", async () => {
  const first = await encodeAttachments(
    [textAttachment({ text: "" })],
    context("codex"),
  );
  expect(first.bubbleAttachments[0]).toMatchObject({
    size: 0,
    delivery: "reference",
    attachmentId: "att-text",
  });
  const edited = messageToEditorContent({
    text: "",
    attachments: first.bubbleAttachments,
  });
  const second = await encodeAttachments(edited.attachments, context("codex"));
  expect(second.bubbleAttachments).toEqual(first.bubbleAttachments);
});

it.each(["local", "shared", "legacy root"])(
  "preserves saved legacy text when resending an old transcript from %s",
  async (location) => {
    const body = "original attachment héllo\r\n";
    await transferContextAttachment(root, {
      attachmentId: "att-original",
      filename: "notes.txt",
      mimeType: "text/plain",
      base64: Buffer.from(body).toString("base64"),
    });
    if (location === "shared")
      await setContextGraphAttachmentShared(root, "att-original", true);
    if (location === "legacy root")
      await fs.rename(
        path.join(root, ".context"),
        path.join(root, ".context-graph"),
      );
    const edited = messageToEditorContent({
      text: "edited prompt",
      attachments: [
        {
          name: "notes.txt",
          mimeType: "text/plain",
          kind: "text",
          attachmentId: "att-original",
        },
      ],
    });
    const result = await encodeAttachments(
      edited.attachments,
      context("codex"),
    );
    expect(
      await fs.readFile(
        path.join(root, result.bubbleAttachments[0].diskPath!),
        "utf8",
      ),
    ).toBe(body);
    expect(result.bubbleAttachments[0]).toMatchObject({
      attachmentId: "att-original",
      delivery: "reference",
      size: Buffer.byteLength(body),
    });
    expect(
      transport.write.mock.calls.every(([args]) => args.resolve === true),
    ).toBe(true);
    expect(transport.readText).not.toHaveBeenCalled();
  },
);

it("fails a legacy resend when the saved text is missing instead of saving its empty placeholder", async () => {
  transport.readText.mockResolvedValue(null);
  const attachment = textAttachment({
    text: "",
    contextAttachmentId: "missing",
  });
  await expect(
    encodeAttachments([attachment], context("codex")),
  ).rejects.toThrow(/not available/);
  expect(attachment.sourceFile).toBeUndefined();
  expect(
    transport.write.mock.calls.every(([args]) => args.resolve === true),
  ).toBe(true);
});

it.each(["recovered legacy text\r\n", ""])(
  "saves a confirmed legacy fallback body (%j), including a real empty file",
  async (body) => {
    transport.readText.mockResolvedValue(body);
    const result = await encodeAttachments(
      [textAttachment({ text: "", contextAttachmentId: "att-old" })],
      context("codex"),
    );
    expect(transport.readText).toHaveBeenCalledExactlyOnceWith({
      cwd: root,
      attachmentId: "att-old",
      diskPath: undefined,
    });
    expect(
      await fs.readFile(
        path.join(root, result.bubbleAttachments[0].diskPath!),
        "utf8",
      ),
    ).toBe(body);
  },
);

it("blocks sends on unavailable files and failed saves, retaining the draft", async () => {
  await expect(
    encodeAttachments(
      [textAttachment({ unavailable: true })],
      context("codex"),
    ),
  ).rejects.toThrow(/unavailable/);
  transport.write.mockRejectedValue(new Error("disk full"));
  await expect(
    encodeAttachments([textAttachment()], context("codex")),
  ).rejects.toThrow(/disk full/);
  await expect(
    encodeAttachments([textAttachment()], { ...context("codex"), cwd: null }),
  ).rejects.toThrow(/workspace/);
});

it("reports invalid selections without sending their bytes", async () => {
  const result = await encodeAttachments(
    [textAttachment({ validation: { ok: false, reason: "too big" } })],
    context("codex"),
  );
  expect(result.blocks).toEqual([]);
  expect(result.skipped).toEqual([{ name: "notes.txt", reason: "too big" }]);
  expect(transport.write).not.toHaveBeenCalled();
});
