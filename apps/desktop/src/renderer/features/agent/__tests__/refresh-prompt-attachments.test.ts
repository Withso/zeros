import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTextMessageAttachment } from "@zeros/protocol/agent-messages";
const write = vi.hoisted(() => vi.fn());
vi.mock("../agent-history-client", () => ({
  createContextAttachmentWriter: () => write,
}));
import {
  fileAttachmentReference,
  resetFileAttachmentTransfersForTests,
} from "../file-attachment-transfer";
import {
  refreshPromptAttachments,
  type PromptAttachments,
} from "../refresh-prompt-attachments";

const cwd = "/repo";
const original = (
  id: string,
  kind: "image" | "file",
): AgentTextMessageAttachment => ({
  name: kind === "image" ? "photo.png" : "notes.pdf",
  kind,
  mimeType: kind === "image" ? "image/png" : "application/pdf",
  attachmentId: id,
  delivery: "reference",
  size: 10,
  diskPath: `.context/local/attachments/${id}/${kind === "image" ? "photo.png" : "notes.pdf"}`,
});
const block = (a: AgentTextMessageAttachment) => ({
  type: "text" as const,
  text: fileAttachmentReference(a.name, {
    absolutePath: `${cwd}/${a.diskPath}`,
    relativePath: a.diskPath!,
    mimeType: a.mimeType,
    bytes: a.size!,
  }),
});
const context = { cwd, chatId: "chat", supportsImage: false };

beforeEach(() => {
  resetFileAttachmentTransfersForTests();
  write.mockReset().mockImplementation(async (args) => ({
    relativePath: args.diskPath.replace("/local/", "/shared/"),
    absolutePath: `${cwd}/${args.diskPath.replace("/local/", "/shared/")}`,
    mimeType: args.mimeType,
    bytes: 12,
    skipped: true,
  }));
});

describe("attachment references at dispatch", () => {
  it("refreshes image and file paths plus segment metadata while retaining other context blocks", async () => {
    const a = original("one", "image");
    const b = original("two", "file");
    const extra = { type: "text" as const, text: "Additional context" };
    const payload: PromptAttachments = {
      attachments: [block(a), extra, block(b)],
      bubbleAttachments: [a, b],
      segments: [
        { type: "text", text: "Look" },
        { type: "attachment", ...a },
        { type: "attachment", ...b },
      ],
    };
    const result = await refreshPromptAttachments(payload, context);
    expect(
      write.mock.calls.every(
        ([args]) => args.resolve === true && args.base64 === "",
      ),
    ).toBe(true);
    expect(write.mock.calls.map(([args]) => args.diskPath)).toEqual([
      a.diskPath,
      b.diskPath,
    ]);
    expect(result.attachments?.[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("/shared/attachments/one/photo.png"),
    });
    expect(result.attachments?.[2]).toMatchObject({
      type: "text",
      text: expect.stringContaining("/shared/attachments/two/notes.pdf"),
    });
    expect(result.attachments?.[1]).toBe(extra);
    expect(result.bubbleAttachments?.[0]).toMatchObject({
      diskPath: a.diskPath!.replace("/local/", "/shared/"),
      size: 12,
    });
    expect(result.segments?.[1]).toMatchObject({
      type: "attachment",
      diskPath: a.diskPath!.replace("/local/", "/shared/"),
      size: 12,
    });
    expect(payload.attachments?.[0]).toEqual(block(a));
  });
  it("rejects a missing file without returning a partial payload", async () => {
    const a = original("one", "file");
    write.mockRejectedValue(new Error("The saved attachment is not available"));
    await expect(
      refreshPromptAttachments(
        { attachments: [block(a)], bubbleAttachments: [a] },
        context,
      ),
    ).rejects.toThrow(/not available/);
  });
  it("leaves messages without file references untouched", async () => {
    const payload = {
      attachments: [{ type: "text" as const, text: "context" }],
    };
    expect(await refreshPromptAttachments(payload, context)).toBe(payload);
    expect(write).not.toHaveBeenCalled();
  });
  it("rejects mismatched wire blocks instead of silently dropping an attachment", async () => {
    await expect(
      refreshPromptAttachments(
        { attachments: [], bubbleAttachments: [original("one", "file")] },
        context,
      ),
    ).rejects.toThrow(/incomplete/);
  });
});
