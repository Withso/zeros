import { afterEach, expect, it, vi } from "vitest";
import { prepareAttachmentSource } from "../attachment-sources";
import type { ComposerAttachment } from "../composer-attachments";

afterEach(() => vi.unstubAllGlobals());
it("refuses to promise recoverable Create bytes when device storage is unavailable", async () => {
  vi.stubGlobal("indexedDB", undefined);
  const attachment: ComposerAttachment = {
    id: "new-file", name: "notes.txt", size: 5, mimeType: "text/plain", kind: "file",
    data: "", sourceFile: new Blob(["notes"]), sourcePortable: true, validation: { ok: true },
  };
  await expect(prepareAttachmentSource(attachment)).rejects.toThrow(/storage.*unavailable/i);
});
