import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ source: vi.fn() }));
vi.mock("../attachment-sources", () => ({ prepareAttachmentSource: mocks.source, supplyLegacyAttachmentBytes: (value: any) => { if (value.text) value.sourceFile = new Blob([value.text]); } }));
import { encodeCloudPromptAttachments } from "../cloud-prompt-attachments";
import { attachmentOwner } from "../attachment-owner";
import type { ComposerAttachment } from "../composer-attachments";
const cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const file = (): ComposerAttachment => ({ id: "file", name: "tiny.txt", mimeType: "text/plain", kind: "text", size: 2, data: "", text: "ok", validation: { ok: true } });
it("freezes attachment bytes and bubble references without touching a VM or bridge", async () => {
  mocks.source.mockResolvedValueOnce({ blob: new Blob(["ok"]) });
  const result = await encodeCloudPromptAttachments([file()], cwd);
  expect(result.blocks).toEqual([{ type: "resource", resource: { uri: "zeros-attachment://file/tiny.txt", mimeType: "text/plain", blob: "b2s=" } }]);
  expect(result.bubbleAttachments[0]).toMatchObject({ attachmentId: "file", diskPath: ".context/local/attachments/file/tiny.txt", delivery: "reference" });
  expect(mocks.source).toHaveBeenLastCalledWith(expect.anything(), true);
});
it("keeps only confirmed references belonging to this exact cloud workspace", async () => {
  const saved = { ...file(), text: undefined, delivery: "reference" as const, diskPath: ".context/local/attachments/file/tiny.txt", owner: attachmentOwner(cwd) };
  mocks.source.mockRejectedValue(new Error("unavailable"));
  expect((await encodeCloudPromptAttachments([saved], cwd)).blocks[0]).toMatchObject({ type: "text", text: expect.stringContaining(saved.diskPath) });
  await expect(encodeCloudPromptAttachments([{ ...saved, owner: { runtime: "local", cwd: "/private" } }], cwd)).rejects.toThrow(/attach.*again/i);
  await expect(encodeCloudPromptAttachments([{ ...saved, diskPath: "../../outside" }], cwd)).rejects.toThrow(/attach.*again/i);
});
it("refuses missing or oversized attachments instead of silently dropping them", async () => {
  mocks.source.mockResolvedValue({ blob: new Blob([new Uint8Array(7 * 1024 * 1024)]) });
  await expect(encodeCloudPromptAttachments([file()], cwd)).rejects.toThrow(/large/i);
  await expect(encodeCloudPromptAttachments([{ ...file(), unavailable: true }], cwd)).rejects.toThrow(/attach.*again/i);
});
