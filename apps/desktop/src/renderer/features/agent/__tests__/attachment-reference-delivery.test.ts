import { beforeEach, describe, expect, it, vi } from "vitest";

const { write, readImage, readText } = vi.hoisted(() => ({
  write: vi.fn(),
  readImage: vi.fn(),
  readText: vi.fn(),
}));
vi.mock("../agent-history-client", () => ({
  createContextAttachmentWriter: () => write,
  writeContextAttachment: write,
  readImageAttachment: readImage,
  readTextAttachment: readText,
}));

import { encodeAttachments } from "../encode-attachments";
import { messageToEditorContent } from "../composer-editor/reconstruct";
import { resetFileAttachmentTransfersForTests } from "../file-attachment-transfer";
import type { AttachmentWriteResult } from "@zeros/protocol/attachment-policy";
import type { ComposerAttachment } from "../composer-attachments";

const text: ComposerAttachment = {
  id: "att-notes",
  name: "notes.md",
  mimeType: "text/markdown",
  kind: "text",
  data: "",
  text: "attachment body must stay on disk",
  size: 33,
  validation: { ok: true },
};
const image: ComposerAttachment = {
  id: "att-image",
  name: "screen.png",
  mimeType: "image/png",
  kind: "image",
  data: "aW1hZ2UtYnl0ZXM=",
  size: 11,
  validation: { ok: true },
};
const ctx = {
  cwd: "/repo",
  chatId: "chat",
  agentId: "claude",
  supportsImage: true,
};
function saved(id: string, filename: string, mimeType: string, bytes = 11) {
  return {
    absolutePath: `/repo/.context/local/attachments/${id}/${filename}`,
    relativePath: `.context/local/attachments/${id}/${filename}`,
    bytes,
    mimeType,
  };
}

type WriteArgs = {
  cwd: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  uploadId?: string;
  base64: string;
  totalBytes?: number;
};

function writeResult(args: WriteArgs, result?: AttachmentWriteResult) {
  return {
    ...saved(args.attachmentId, args.filename, args.mimeType),
    ...result,
    bytes: args.totalBytes ?? result?.bytes ?? 11,
    ...(args.uploadId && args.base64 === "" ? { bytes: 0, pending: true } : {}),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  resetFileAttachmentTransfersForTests();
  write.mockImplementation(async (args: WriteArgs) => writeResult(args));
});

describe.each(["claude", "codex", "cursor"])(
  "%s attachment references",
  (agentId) => {
    it.each([true, false])(
      "sends file references with native image support=%s",
      async (supportsImage) => {
        const result = await encodeAttachments([structuredClone(text), structuredClone(image)], {
          ...ctx,
          agentId,
          supportsImage,
        });
        expect(result.skipped).toEqual([]);
        expect(result.blocks).toHaveLength(2);
        expect(result.blocks.every((block) => block.type === "text")).toBe(
          true,
        );
        const prompt = JSON.stringify(result.blocks);
        expect(prompt).toContain(
          ".context/local/attachments/att-notes/notes.md",
        );
        expect(prompt).toContain(
          ".context/local/attachments/att-image/screen.png",
        );
        expect(prompt).not.toContain(text.text);
        expect(prompt).not.toContain(image.data);
        expect(prompt).not.toContain("<file ");
        expect(prompt).toMatch(/read|inspect/i);
        expect(prompt).toContain("image-reading tool");
        expect(result.bubbleAttachments.map((a) => a.diskPath)).toEqual([
          saved(text.id, text.name, text.mimeType).relativePath,
          saved(image.id, image.name, image.mimeType).relativePath,
        ]);
      },
    );

    it("keeps references on an edited resend of an older message", async () => {
      const original = {
        text: "review",
        attachments: [
          {
            name: text.name,
            mimeType: text.mimeType,
            kind: "text" as const,
            attachmentId: text.id,
          },
          {
            name: image.name,
            mimeType: image.mimeType,
            kind: "image" as const,
            thumbnailUri: `data:image/png;base64,${image.data}`,
          },
        ],
      };
      readText.mockResolvedValue(text.text);
      const result = await encodeAttachments(
        messageToEditorContent(original).attachments,
        { ...ctx, agentId },
      );
      expect(result.skipped).toEqual([]);
      expect(result.blocks.every((b) => b.type === "text")).toBe(true);
      expect(JSON.stringify(result.blocks)).not.toContain(text.text);
      expect(JSON.stringify(result.blocks)).not.toContain(image.data);
      expect(result.bubbleAttachments[0].attachmentId).toBe(text.id);
      expect(write.mock.calls[0][0].attachmentId).toBe(text.id);
    });
  },
);

it("waits for text persistence before releasing its reference", async () => {
  let finish!: (value: ReturnType<typeof saved>) => void;
  write.mockImplementation((args: WriteArgs) =>
    args.uploadId && args.base64 === ""
      ? Promise.resolve(writeResult(args))
      : new Promise<ReturnType<typeof saved>>((resolve) => {
          finish = resolve;
        }).then((result) => writeResult(args, result)),
  );
  let complete = false;
  const sending = encodeAttachments([structuredClone(text)], ctx).then((result) => {
    complete = true;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(complete).toBe(false);
  finish(saved(text.id, text.name, text.mimeType));
  expect((await sending).skipped).toEqual([]);
});

it.each([text, image])(
  "does not fall back to inline $kind contents when persistence fails",
  async (attachment) => {
    write.mockRejectedValue(new Error("disk unavailable"));
    await expect(encodeAttachments([structuredClone(attachment)], ctx))
      .rejects.toThrow("disk unavailable");
  },
);

it("requires a workspace for every attachment", async () => {
  await expect(encodeAttachments([structuredClone(text), structuredClone(image)], { ...ctx, cwd: null }))
    .rejects.toThrow(/workspace/);
  expect(write).not.toHaveBeenCalled();
});

it("does not publish an unfinished write as a file reference", async () => {
  write.mockResolvedValue({ absolutePath: "", relativePath: "", bytes: 0, pending: true });
  await expect(encodeAttachments([structuredClone(text)], ctx))
    .rejects.toThrow("Attachment transfer did not finish");
});

it("uses the confirmed shared location and sanitized filename", async () => {
  write.mockImplementation(async (args: WriteArgs) => writeResult(args, {
    absolutePath: "/repo/.context/shared/attachments/att-notes/safe.md",
    relativePath: ".context/shared/attachments/att-notes/safe.md",
    mimeType: "text/markdown",
    bytes: 33,
  }));
  const result = await encodeAttachments(
    [{ ...text, name: 'my "notes".md' }],
    ctx,
  );
  expect(result.blocks[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining(
      "/repo/.context/shared/attachments/att-notes/safe.md",
    ),
  });
  expect(result.bubbleAttachments[0].diskPath).toBe(
    ".context/shared/attachments/att-notes/safe.md",
  );
});

it("keeps concurrent workspace paths isolated when writes finish out of order", async () => {
  let finish!: (value: ReturnType<typeof saved>) => void;
  write.mockImplementation((args: WriteArgs) =>
    args.uploadId && args.base64 === ""
      ? Promise.resolve(writeResult(args))
      : args.cwd === "/first"
      ? new Promise<ReturnType<typeof saved>>((resolve) => {
          finish = resolve;
        }).then((result) => writeResult(args, result))
      : Promise.resolve(writeResult(args, {
          ...saved(args.attachmentId, args.filename, args.mimeType),
          absolutePath: "/second/.context/local/attachments/att-notes/notes.md",
        })),
  );
  const first = encodeAttachments([structuredClone(text)], { ...ctx, cwd: "/first" });
  const second = await encodeAttachments([structuredClone(text)], { ...ctx, cwd: "/second" });
  expect(JSON.stringify(second.blocks)).toContain("/second/.context/");
  finish({
    ...saved(text.id, text.name, text.mimeType),
    absolutePath: "/first/.context/local/attachments/att-notes/notes.md",
  });
  expect(JSON.stringify((await first).blocks)).toContain("/first/.context/");
});
