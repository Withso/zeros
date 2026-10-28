import { describe, expect, it, vi } from "vitest";
import { deflateRawSync } from "node:zlib";
import { FILE_MEDIA_CHUNK_BYTES } from "@zeros/protocol/file-media";
import {
  DocumentPreviewError,
  readDocumentBytes,
  validateDocxArchive,
} from "../document-preview-source";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/renderer/platform/files", () => ({
  createWorkspaceMediaReader: () => read,
}));

function wordArchive(
  options: {
    compressed?: boolean;
    declaredSize?: number;
    localName?: string;
    method?: number;
  } = {},
) {
  const name = Buffer.from("word/document.xml");
  const localName = Buffer.from(options.localName ?? name.toString());
  const data = Buffer.from(
    "<document>" + "readable text ".repeat(100) + "</document>",
  );
  const content = options.compressed ? deflateRawSync(data) : data;
  const size = options.declaredSize ?? data.length;
  const method = options.method ?? (options.compressed ? 8 : 0);
  const local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    footer = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(localName.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  footer.writeUInt32LE(0x06054b50);
  footer.writeUInt16LE(1, 8);
  footer.writeUInt16LE(1, 10);
  footer.writeUInt32LE(central.length + name.length, 12);
  footer.writeUInt32LE(local.length + localName.length + content.length, 16);
  return Buffer.concat([local, localName, content, central, name, footer]);
}

describe("document preview sources", () => {
  it("distinguishes readable source failures from internal reader errors", async () => {
    await expect(
      readDocumentBytes({ path: "empty.docx", bytes: 0 }, new AbortController().signal),
    ).rejects.toBeInstanceOf(DocumentPreviewError);
    await expect(validateDocxArchive(new Uint8Array())).rejects.toBeInstanceOf(DocumentPreviewError);
    const internal = new Error("The document reader returned an internal fixture error");
    read.mockReset().mockRejectedValue(internal);
    await expect(readDocumentBytes({
      cwd: "/repo", path: "report.docx", bytes: 1,
      media: { version: "1", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    }, new AbortController().signal)).rejects.toBe(internal);
    expect(internal).not.toBeInstanceOf(DocumentPreviewError);
  });

  it.each(["/personal", "/organization", "cloud://organization/workspace"])(
    "reads exact bounded ranges for %s",
    async (cwd) => {
      read.mockReset().mockImplementation(async ({ offset, length }) => ({
        bytes: length,
        base64: Buffer.alloc(length, offset ? 2 : 1).toString("base64"),
      }));
      const bytes = await readDocumentBytes(
        {
          cwd,
          path: "report.docx",
          bytes: FILE_MEDIA_CHUNK_BYTES + 1,
          media: {
            version: "1:2:3",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        },
        new AbortController().signal,
      );
      expect(read.mock.calls.map(([input]) => input)).toEqual([
        {
          path: "report.docx",
          version: "1:2:3",
          offset: 0,
          length: FILE_MEDIA_CHUNK_BYTES,
        },
        {
          path: "report.docx",
          version: "1:2:3",
          offset: FILE_MEDIA_CHUNK_BYTES,
          length: 1,
        },
      ]);
      expect([bytes[0], bytes.at(-1)]).toEqual([1, 2]);
    },
  );

  it("cancels a held read before another range can start", async () => {
    let finish!: (value: { bytes: number; base64: string }) => void;
    read.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const request = readDocumentBytes(
      {
        cwd: "/repo",
        path: "report.docx",
        bytes: FILE_MEDIA_CHUNK_BYTES + 1,
        media: {
          version: "1",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      },
      controller.signal,
    );
    const failure = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    finish({ bytes: FILE_MEDIA_CHUNK_BYTES, base64: "" });
    await failure;
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("checks the selected Blob's actual size before reading it", async () => {
    const blob = { size: 50_000_001, arrayBuffer: vi.fn() } as unknown as Blob;
    await expect(
      readDocumentBytes(
        { path: "large.docx", bytes: 1, blob },
        new AbortController().signal,
      ),
    ).rejects.toThrow("too large");
    expect(blob.arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects malformed and non-Word containers", async () => {
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array(80),
      new TextEncoder().encode("Not a Word document"),
    ]) {
      await expect(
        Promise.resolve().then(() => validateDocxArchive(bytes)),
      ).rejects.toThrow("can't be previewed");
    }
  });

  it.each([
    { localName: "word/other.xml" },
    { method: 99 },
    { declaredSize: 1 },
  ])(
    "rejects inconsistent ZIP metadata before expansion: %j",
    async (options) => {
      await expect(
        Promise.resolve().then(() => validateDocxArchive(wordArchive(options))),
      ).rejects.toThrow("can't be previewed");
    },
  );

  it("rejects a central-directory offset outside the local file data", async () => {
    const data = wordArchive();
    const central = data.readUInt32LE(data.length - 6);
    data.writeUInt32LE(data.length, central + 42);
    await expect(
      Promise.resolve().then(() => validateDocxArchive(data)),
    ).rejects.toThrow("can't be previewed");
  });

  it("bounds actual inflated bytes even when both ZIP headers underreport them", async () => {
    await expect(
      Promise.resolve().then(() =>
        validateDocxArchive(wordArchive({ compressed: true, declaredSize: 1 })),
      ),
    ).rejects.toThrow("can't be previewed");
  });

  it.each([false, true])(
    "accepts ordinary Word ZIP content (compressed: %s)",
    async (compressed) => {
      await expect(
        Promise.resolve().then(() =>
          validateDocxArchive(wordArchive({ compressed })),
        ),
      ).resolves.toBeUndefined();
    },
  );
});
