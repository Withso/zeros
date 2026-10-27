import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("../file-attachment-transfer", () => ({ ensureFileAttachment: mocks.upload }));
import { encodeCloudPromptAttachments } from "../cloud-prompt-attachments";
import { attachmentOwner } from "../attachment-owner";
import type { ComposerAttachment } from "../composer-attachments";
const cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const file = (): ComposerAttachment => ({ id: "file", name: "clip.mp4", mimeType: "video/mp4", kind: "file", size: 500_000_000, data: "", delivery: "reference", validation: { ok: true } });
beforeEach(() => { mocks.upload.mockReset().mockResolvedValue({ relativePath: ".context/attachments/file/clip.mp4", absolutePath: "/workspace/.context/attachments/file/clip.mp4", bytes: 500_000_000, mimeType: "video/mp4" }); });

it("waits for the shared 500 MB transfer and journals only a small file reference", async () => {
  let finish!: (result: unknown) => void;
  mocks.upload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const source = new Blob(["fixture"]);
  const read = vi.spyOn(source, "arrayBuffer");
  const attachment = { ...file(), sourceFile: source };
  let settled = false;
  const pending = encodeCloudPromptAttachments([attachment], cwd).then(result => { settled = true; return result; });
  await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  finish({ relativePath: ".context/attachments/file/clip.mp4", bytes: 500_000_000 });
  const result = await pending;
  expect(result.blocks).toEqual([{ type: "text", text: expect.stringContaining(".context/attachments/file/clip.mp4") }]);
  expect(result.bubbleAttachments[0]).toMatchObject({ size: 500_000_000, delivery: "reference", attachmentId: "file" });
  expect(JSON.stringify(result).length).toBeLessThan(1500);
  expect(read).not.toHaveBeenCalled();
});
it("reuses confirmed references while sleeping, including flat and legacy paths", async () => {
  for (const path of [".context/attachments/file/clip.mp4", ".context/local/attachments/file/clip.mp4", ".context-graph/shared/attachments/file/clip.mp4"]) {
    const saved = { ...file(), diskPath: path, owner: attachmentOwner(cwd) };
    expect((await encodeCloudPromptAttachments([saved], cwd)).blocks[0]).toMatchObject({ type: "text", text: expect.stringContaining(path) });
  }
  expect(mocks.upload).not.toHaveBeenCalled();
});
it("refuses foreign-owner paths, invalid files and files above the 500 MB cap", async () => {
  const saved = { ...file(), diskPath: ".context/attachments/file/clip.mp4", owner: { runtime: "local", cwd: "/private" } };
  await expect(encodeCloudPromptAttachments([saved], cwd)).rejects.toThrow(/attach.*again/i);
  await expect(encodeCloudPromptAttachments([{ ...saved, diskPath: "../../outside" }], cwd)).rejects.toThrow(/attach.*again/i);
  await expect(encodeCloudPromptAttachments([{ ...file(), size: 500_000_001 }], cwd)).rejects.toThrow(/500 MB/);
  await expect(encodeCloudPromptAttachments([{ ...file(), unavailable: true }], cwd)).rejects.toThrow(/attach.*again/i);
  expect(mocks.upload).not.toHaveBeenCalled();
});
it("keeps a failed transfer unsent instead of committing a missing file reference", async () => {
  mocks.upload.mockRejectedValue(new Error("Upload interrupted"));
  await expect(encodeCloudPromptAttachments([file()], cwd)).rejects.toThrow("Upload interrupted");
});
