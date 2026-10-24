import { beforeEach, expect, it, vi } from "vitest";
import type { ComposerAttachment } from "../../../features/agent/composer-attachments";
const source = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../../../features/agent/attachment-sources", () => ({ prepareAttachmentSource: source.prepare, supplyLegacyAttachmentBytes: vi.fn() }));
import { MAX_CREATE_TEXT_PREVIEW_BYTES, readCreateAttachmentPreview } from "../create-attachment-preview";
const attachment = (name: string, blob: Blob): ComposerAttachment => ({ id: "draft-file", name, mimeType: blob.type || "application/octet-stream", size: blob.size, kind: "file", data: "", validation: { ok: true }, sourceRecoveryId: "a".repeat(36), sourcePortable: true });
beforeEach(() => { source.prepare.mockReset(); });
it.each(["notes.md", "notes.txt", "events.jsonl", "settings.toml"])("previews restored %s without a workspace or native source", async name => {
  const blob = new Blob(["# Hello\r\nExact text\n"]);
  source.prepare.mockResolvedValue({ blob });
  expect(await readCreateAttachmentPreview(attachment(name, blob))).toMatchObject({ kind: name.endsWith(".md") ? "markdown" : "text", text: "# Hello\r\nExact text\n", truncated: false });
  expect(source.prepare).toHaveBeenCalledWith(expect.objectContaining({ sourceRecoveryId: "a".repeat(36) }), true);
});
it.each([["shot.PNG", "image"], ["demo.mp4", "video"], ["recording.webm", "video"], ["sound.wav", "audio"], ["document.pdf", "unsupported"]])("keeps %s as a Blob for the %s viewer", async (name, kind) => {
  const blob = new Blob([new Uint8Array([0, 1, 2, 3])]);
  const read = vi.spyOn(blob, "arrayBuffer");
  source.prepare.mockResolvedValue({ blob });
  const result = await readCreateAttachmentPreview(attachment(name, blob));
  expect(result.kind).toBe(kind);
  expect(result.blob.size).toBe(blob.size);
  expect(read).not.toHaveBeenCalled();
});
it("bounds large text reads and does not split a final UTF-8 character", async () => {
  const blob = new Blob(["x".repeat(MAX_CREATE_TEXT_PREVIEW_BYTES - 1), "€tail"]);
  source.prepare.mockResolvedValue({ blob });
  const result = await readCreateAttachmentPreview(attachment("large.txt", blob));
  expect(result.kind).toBe("text");
  expect(result.truncated).toBe(true);
  expect(result.text).toHaveLength(MAX_CREATE_TEXT_PREVIEW_BYTES - 1);
});
it("offers a binary fallback and supports genuinely empty text", async () => {
  for (const [blob, kind] of [[new Blob([new Uint8Array([0, 255])]), "unsupported"], [new Blob([]), "text"]] as const) {
    source.prepare.mockResolvedValue({ blob });
    expect((await readCreateAttachmentPreview(attachment("data.bin", blob))).kind).toBe(kind);
  }
});
it.each(["constructor", "__proto__"])("treats %s as a filename rather than an inherited media registry entry", async name => {
  const blob = new Blob(["ordinary text"]);
  source.prepare.mockResolvedValue({ blob });
  expect((await readCreateAttachmentPreview(attachment(name, blob))).kind).toBe("text");
});
it("fails visibly for missing or changed recovery sources", async () => {
  const blob = new Blob(["old"]);
  source.prepare.mockResolvedValue({ blob: new Blob(["changed"]) });
  await expect(readCreateAttachmentPreview(attachment("notes.txt", blob))).rejects.toThrow(/unavailable/);
  source.prepare.mockRejectedValue(new Error("Recovery source missing"));
  await expect(readCreateAttachmentPreview(attachment("notes.txt", blob))).rejects.toThrow(/missing/);
});
