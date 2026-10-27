import { afterEach, expect, it, vi } from "vitest";
import { ATTACHMENT_CHUNK_BYTES } from "@zeros/protocol/attachment-policy";
const write = vi.hoisted(() => vi.fn());
vi.mock("../agent-history-client", () => ({ createContextAttachmentWriter: () => write }));
import { ensureFileAttachment, resetFileAttachmentTransfersForTests } from "../file-attachment-transfer";
import { encodeCloudPromptAttachments } from "../cloud-prompt-attachments";
import type { ComposerAttachment } from "../composer-attachments";
afterEach(() => resetFileAttachmentTransfersForTests());

it("attach and Send share one chunk upload; only a confirmed path enters the cloud prompt", async () => {
  const cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  const bytes = new Uint8Array(2 * ATTACHMENT_CHUNK_BYTES + 3).fill(7);
  const file = new Blob([bytes], { type: "video/mp4" }), whole = vi.spyOn(file, "arrayBuffer");
  const attachment: ComposerAttachment = { id: "video", name: "clip.mp4", mimeType: "video/mp4", kind: "file", size: bytes.length,
    data: "", sourceFile: file, delivery: "reference", validation: { ok: true } };
  const chunks: Buffer[] = [];
  let acknowledge!: () => void;
  write.mockImplementation(async args => {
    const chunk = Buffer.from(args.base64, "base64");
    expect(chunk.length).toBeLessThanOrEqual(ATTACHMENT_CHUNK_BYTES);
    if (chunk.length) chunks.push(chunk);
    if (args.offset + chunk.length < args.totalBytes) return { bytes: args.offset + chunk.length, pending: true };
    await new Promise<void>(resolve => { acknowledge = resolve; });
    return { bytes: bytes.length, relativePath: ".context/attachments/video/clip.mp4", absolutePath: `${cwd}/.context/attachments/video/clip.mp4`, mimeType: "video/mp4" };
  });
  const attached = ensureFileAttachment(cwd, attachment);
  const sent = vi.fn(), sending = encodeCloudPromptAttachments([attachment], cwd).then(value => { sent(value); return value; });
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
  expect(sent).not.toHaveBeenCalled(); expect(whole).not.toHaveBeenCalled();
  expect(write).toHaveBeenCalledTimes(4);
  acknowledge(); await attached;
  const result = await sending;
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
  expect(result.blocks).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining(".context/attachments/video/clip.mp4") })]);
  expect(JSON.stringify(result).length).toBeLessThan(2048);
  expect(result.bubbleAttachments[0]).toMatchObject({ size: bytes.length, delivery: "reference", attachmentId: "video" });
});
