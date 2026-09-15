import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  readTextAttachment: vi.fn(),
  writeContextAttachment: vi.fn(),
}));
vi.mock("../agent-history-client", () => io);

import { attachmentTextPreviewsCache } from "../../../state/read-caches";
import { textFileAttachment } from "../composer-editor/attachment-io";
import {
  MAX_ATTACHMENT_PREVIEW_BYTES,
  attachmentTextPreviewKey,
  readAttachmentTextPreview,
  warmAttachmentTextPreview,
} from "../composer-editor/attachment-text-preview";

beforeEach(() => {
  attachmentTextPreviewsCache.clear();
  io.readTextAttachment.mockReset();
  io.writeContextAttachment.mockReset();
});

describe("staged transcript previews", () => {
  it("shares the selected Blob read without adding its body to the draft", async () => {
    const a = textFileAttachment("transcript.txt", "The frozen transcript 🧭");
    const read = vi.spyOn(a.sourceFile!, "text");
    const first = warmAttachmentTextPreview("/a", a);
    const second = warmAttachmentTextPreview("/a", a);
    expect(second).toBe(first);
    await expect(first).resolves.toBe("The frozen transcript 🧭");
    await warmAttachmentTextPreview("/a", a);
    expect(read).toHaveBeenCalledOnce();
    expect(a.text).toBeUndefined();
    expect(JSON.stringify(a)).not.toContain("The frozen transcript");
    expect(io.readTextAttachment).not.toHaveBeenCalled();
    expect(io.writeContextAttachment).not.toHaveBeenCalled();
  });

  it("resolves restored metadata by stable id before reading the current file", async () => {
    const a = {
      ...textFileAttachment("transcript.txt", "saved"),
      id: "att-edit-1",
      contextAttachmentId: "att-original",
      sourceFile: undefined,
    };
    const relativePath =
      ".context/shared/attachments/att-original/transcript.txt";
    io.writeContextAttachment.mockResolvedValue({ relativePath });
    io.readTextAttachment.mockResolvedValue("saved transcript");
    await expect(warmAttachmentTextPreview("/a", a)).resolves.toBe(
      "saved transcript",
    );
    expect(io.writeContextAttachment).toHaveBeenCalledWith({
      cwd: "/a",
      attachmentId: "att-original",
      filename: "transcript.txt",
      mimeType: "text/plain",
      base64: "",
      resolve: true,
    });
    expect(io.readTextAttachment).toHaveBeenCalledWith({
      cwd: "/a",
      attachmentId: "att-original",
      diskPath: relativePath,
    });
  });

  it("isolates late workspace results and retains the A → B → A snapshot", async () => {
    const a = textFileAttachment("transcript.txt", "A");
    const b = { ...textFileAttachment("transcript.txt", "B"), id: a.id };
    let resolveA!: (value: string) => void;
    vi.spyOn(a.sourceFile!, "text").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveA = resolve;
        }),
    );
    const keyA = attachmentTextPreviewKey("/a", a);
    const keyB = attachmentTextPreviewKey("/b", b);
    const pendingA = warmAttachmentTextPreview("/a", a);
    await expect(warmAttachmentTextPreview("/b", b)).resolves.toBe("B");
    expect(attachmentTextPreviewsCache.peekSnapshot(keyA).data).toBeUndefined();
    resolveA("A");
    await pendingA;
    expect(attachmentTextPreviewsCache.peekSnapshot(keyB).data).toBe("B");
    expect(attachmentTextPreviewsCache.peekSnapshot(keyA).data).toBe("A");
    await expect(warmAttachmentTextPreview("/a", a)).resolves.toBe("A");
    expect(a.sourceFile!.text).toHaveBeenCalledOnce();
  });

  it("retains confirmed preview text when a restored file becomes unavailable", async () => {
    const a = {
      ...textFileAttachment("transcript.txt", "saved"),
      sourceFile: undefined,
    };
    const key = attachmentTextPreviewKey("/a", a);
    io.writeContextAttachment.mockResolvedValue({
      relativePath: ".context/local/attachments/att-1/transcript.txt",
    });
    io.readTextAttachment.mockResolvedValueOnce("confirmed");
    await warmAttachmentTextPreview("/a", a);
    attachmentTextPreviewsCache.invalidate(key);
    io.readTextAttachment.mockResolvedValueOnce(null);
    await expect(warmAttachmentTextPreview("/a", a)).rejects.toThrow(
      /unavailable/,
    );
    expect(attachmentTextPreviewsCache.peekSnapshot(key).data).toBe(
      "confirmed",
    );
  });

  it("keeps inactive preview retention bounded", async () => {
    const first = textFileAttachment("first.txt", "first");
    await warmAttachmentTextPreview("/a", first);
    for (let i = 0; i < 16; i++) {
      await warmAttachmentTextPreview(
        "/a",
        textFileAttachment(`${i}.txt`, "body"),
      );
    }
    expect(
      attachmentTextPreviewsCache.peekSnapshot(
        attachmentTextPreviewKey("/a", first),
      ).data,
    ).toBeUndefined();
    expect([...attachmentTextPreviewsCache.keys()]).toHaveLength(16);
  });

  it("refuses an oversized Blob before reading its contents", async () => {
    const a = textFileAttachment("transcript.txt", "");
    const text = vi.fn();
    a.sourceFile = {
      size: MAX_ATTACHMENT_PREVIEW_BYTES + 1,
      text,
    } as unknown as Blob;
    await expect(readAttachmentTextPreview("/a", a)).rejects.toThrow(
      /too large/,
    );
    expect(text).not.toHaveBeenCalled();
  });

  it("keeps legacy inline transcript previews readable without a workspace", async () => {
    const a = {
      ...textFileAttachment("transcript.txt", ""),
      sourceFile: undefined,
      delivery: undefined,
      text: "legacy snapshot",
    };
    await expect(readAttachmentTextPreview(null, a)).resolves.toBe(
      "legacy snapshot",
    );
    expect(io.writeContextAttachment).not.toHaveBeenCalled();
  });
});
