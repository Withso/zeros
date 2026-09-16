import { beforeEach, describe, expect, it, vi } from "vitest";

const { write, readImage, readText } = vi.hoisted(() => ({
  write: vi.fn(),
  readImage: vi.fn(),
  readText: vi.fn(),
}));
vi.mock("../agent-history-client", () => ({
  writeContextAttachment: write,
  readImageAttachment: readImage,
  readTextAttachment: readText,
}));

import { encodeAttachments } from "../encode-attachments";
import { messageToEditorContent } from "../composer-editor/reconstruct";
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
function saved(id: string, filename: string, mimeType: string) {
  return {
    absolutePath: `/repo/.context/local/attachments/${id}/${filename}`,
    relativePath: `.context/local/attachments/${id}/${filename}`,
    bytes: 11,
    mimeType,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  write.mockImplementation(async (args) =>
    saved(args.attachmentId, args.filename, args.mimeType),
  );
});

describe.each(["claude", "codex", "cursor"])(
  "%s attachment references",
  (agentId) => {
    it.each([true, false])(
      "sends file references with native image support=%s",
      async (supportsImage) => {
        const result = await encodeAttachments([text, image], {
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
  write.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let complete = false;
  const sending = encodeAttachments([text], ctx).then((result) => {
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
    const result = await encodeAttachments([attachment], ctx);
    expect(result.blocks).toEqual([]);
    expect(result.bubbleAttachments).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  },
);

it("requires a workspace for every attachment", async () => {
  const result = await encodeAttachments([text, image], { ...ctx, cwd: null });
  expect(result.blocks).toEqual([]);
  expect(result.skipped).toHaveLength(2);
  expect(write).not.toHaveBeenCalled();
});

it("does not publish an unfinished write as a file reference", async () => {
  write.mockResolvedValue({ absolutePath: "", relativePath: "", bytes: 0 });
  const result = await encodeAttachments([text], ctx);
  expect(result.blocks).toEqual([]);
  expect(result.bubbleAttachments).toEqual([]);
  expect(result.skipped).toHaveLength(1);
});

it("uses the confirmed shared location and sanitized filename", async () => {
  write.mockResolvedValue({
    absolutePath: "/repo/.context/shared/attachments/att-notes/safe.md",
    relativePath: ".context/shared/attachments/att-notes/safe.md",
    mimeType: "text/markdown",
    bytes: 33,
  });
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
  write.mockImplementation((args) =>
    args.cwd === "/first"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({
          ...saved(args.attachmentId, args.filename, args.mimeType),
          absolutePath: "/second/.context/local/attachments/att-notes/notes.md",
        }),
  );
  const first = encodeAttachments([text], { ...ctx, cwd: "/first" });
  const second = await encodeAttachments([text], { ...ctx, cwd: "/second" });
  expect(JSON.stringify(second.blocks)).toContain("/second/.context/");
  finish({
    ...saved(text.id, text.name, text.mimeType),
    absolutePath: "/first/.context/local/attachments/att-notes/notes.md",
  });
  expect(JSON.stringify((await first).blocks)).toContain("/first/.context/");
});
