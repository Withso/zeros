import { beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_MEDIA_CHUNK_BYTES } from "@zeros/protocol/file-media";
import { openPdfDocument } from "../file-pdf-runtime";

const { getDocument, read, onRange } = vi.hoisted(() => ({
  getDocument: vi.fn(),
  read: vi.fn(),
  onRange: vi.fn(),
}));
vi.mock("pdfjs-dist", () => ({
  getDocument,
  GlobalWorkerOptions: {},
  PDFDataRangeTransport: class {
    onDataRange = onRange;
  },
}));
vi.mock("@/renderer/platform/files", () => ({
  createWorkspaceMediaReader: () => read,
}));

function open(
  cwd: string,
  onError = vi.fn(),
  bytes = FILE_MEDIA_CHUNK_BYTES * 3,
) {
  openPdfDocument(
    {
      cwd,
      path: "report.pdf",
      bytes,
      media: { version: "1:2:3", mimeType: "application/pdf" },
    },
    onError,
  );
  return getDocument.mock.calls.at(-1)![0].range as {
    requestDataRange(begin: number, end: number): void;
    abort(): void;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  read.mockImplementation(async ({ length }) => ({
    bytes: length,
    base64: Buffer.alloc(length).toString("base64"),
  }));
});

describe("PDF range source", () => {
  it.each(["/personal", "/organization", "cloud://organization/workspace"])(
    "splits coalesced reads at the wire budget for %s",
    async (cwd) => {
      open(cwd).requestDataRange(0, FILE_MEDIA_CHUNK_BYTES * 3);
      await vi.waitFor(() => expect(onRange).toHaveBeenCalledTimes(1));
      expect(read.mock.calls.map(([input]) => input.length)).toEqual(
        Array(3).fill(FILE_MEDIA_CHUNK_BYTES),
      );
      expect(onRange.mock.calls[0][1]).toHaveLength(FILE_MEDIA_CHUNK_BYTES * 3);
    },
  );

  it("refuses an oversized coalesced allocation before reading source bytes", async () => {
    const error = vi.fn();
    open("/personal", error, 64 * 1024 * 1024).requestDataRange(
      0,
      32 * 1024 * 1024 + 1,
    );
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(read).not.toHaveBeenCalled();
    expect(onRange).not.toHaveBeenCalled();
  });

  it("retires held and queued reads when the preview is hidden", async () => {
    let finish!: (value: { bytes: number; base64: string }) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const range = open("/personal");
    range.requestDataRange(0, FILE_MEDIA_CHUNK_BYTES);
    range.requestDataRange(FILE_MEDIA_CHUNK_BYTES, FILE_MEDIA_CHUNK_BYTES * 2);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    range.abort();
    finish({
      bytes: FILE_MEDIA_CHUNK_BYTES,
      base64: Buffer.alloc(FILE_MEDIA_CHUNK_BYTES).toString("base64"),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onRange).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("fails closed after a short response and ignores queued reads", async () => {
    read.mockResolvedValue({ bytes: 0, base64: "" });
    const error = vi.fn(),
      range = open("/organization", error);
    range.requestDataRange(0, FILE_MEDIA_CHUNK_BYTES);
    range.requestDataRange(FILE_MEDIA_CHUNK_BYTES, FILE_MEDIA_CHUNK_BYTES * 2);
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(read).toHaveBeenCalledTimes(1);
    expect(onRange).not.toHaveBeenCalled();
  });
});
