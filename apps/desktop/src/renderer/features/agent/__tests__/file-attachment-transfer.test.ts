import { beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_CHUNK_BYTES } from "@zeros/protocol/attachment-policy";
const write = vi.hoisted(() => vi.fn());
const nativeSource = vi.hoisted(() => vi.fn(async () => null as string | null));
vi.mock("../agent-history-client", () => ({ writeContextAttachment: write, createContextAttachmentWriter: () => write }));
vi.mock("../../../platform/runtime", async (original) => ({ ...await original<object>(), prepareNativeAttachmentFile: nativeSource }));
import {
  ensureFileAttachment,
  getFileAttachmentProgress,
  subscribeFileAttachmentProgress,
  resetFileAttachmentTransfersForTests,
} from "../file-attachment-transfer";
import { filesToAttachments } from "../composer-editor/attachment-io";
import type { ComposerAttachment } from "../composer-attachments";

const final = {
  absolutePath: "/repo/.context/local/attachments/att-1/events.jsonl",
  relativePath: ".context/local/attachments/att-1/events.jsonl",
  mimeType: "application/jsonl",
  bytes: 3,
};
const attachment = (
  over: Partial<ComposerAttachment> = {},
): ComposerAttachment => ({
  id: "att-1",
  name: "events.jsonl",
  kind: "file",
  mimeType: "application/jsonl",
  size: 3,
  data: "",
  delivery: "reference",
  sourceFile: new Blob(["abc"]),
  validation: { ok: true },
  ...over,
});
beforeEach(() => {
  nativeSource.mockReset().mockResolvedValue(null);
  resetFileAttachmentTransfersForTests();
  write
    .mockReset()
    .mockImplementation(async (args) =>
      args.uploadId && args.base64 === "" && !args.abort
        ? { ...final, bytes: 0, pending: true }
        : final,
    );
});

describe("file imports", () => {
  it("stages metadata without reading entire files, including at the limit", async () => {
    const file = {
      name: "events.jsonl",
      type: "application/jsonl",
      size: 500_000_000,
      text: vi.fn(() => {
        throw new Error("whole file read");
      }),
      arrayBuffer: vi.fn(() => {
        throw new Error("whole file read");
      }),
    } as unknown as File;
    const [a] = await filesToAttachments([file], {
      agentName: null,
      agentSupportsImage: false,
      modelId: "unknown",
    });
    expect(a).toMatchObject({
      name: file.name,
      delivery: "reference",
      size: file.size,
      data: "",
      validation: { ok: true },
    });
    expect(file.text).not.toHaveBeenCalled();
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects unsupported files before reading bytes and retains their explanation", async () => {
    const file = {
      name: "installer.apk",
      type: "",
      size: 5,
      text: vi.fn(),
    } as unknown as File;
    const [a] = await filesToAttachments([file], {
      agentName: null,
      agentSupportsImage: false,
      modelId: null,
    });
    expect(a.validation.ok).toBe(false);
    expect(a.sourceFile).toBeUndefined();
    expect(file.text).not.toHaveBeenCalled();
  });
});

describe("reference attachment staging", () => {
  it("copies native files without reading or encoding renderer bytes", async () => {
    nativeSource.mockResolvedValue("native-source-id");
    const source = new Blob(["abc"]);
    const read = vi.spyOn(source, "arrayBuffer");
    const a = attachment({ sourceFile: source });
    await ensureFileAttachment("/repo", a);
    expect(read).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ nativeSourceId: "native-source-id", base64: "" }));
    expect(a.absolutePath).toBe(final.absolutePath);
  });

  it("isolates out-of-order workspace results and publishes the path before readiness", async () => {
    const pending = new Map<string, (value: typeof final) => void>();
    write.mockImplementation(
      (args) => new Promise((resolve) => pending.set(args.cwd, resolve)),
    );
    const a = attachment({ sourceFile: undefined });
    const b = attachment({ sourceFile: undefined });
    let readyPath: string | undefined;
    const unsubscribe = subscribeFileAttachmentProgress("/a", a.id, () => {
      if (getFileAttachmentProgress("/a", a.id)?.phase === "ready")
        readyPath = a.diskPath;
    });
    const first = ensureFileAttachment("/a", a);
    const second = ensureFileAttachment("/b", b);
    await vi.waitFor(() => expect(pending.size).toBe(2));
    pending.get("/b")!({
      ...final,
      absolutePath: "/b/file",
      relativePath: ".context/shared/attachments/att-1/events.jsonl",
    });
    await second;
    expect(getFileAttachmentProgress("/a", a.id)?.phase).toBe("saving");
    expect(a.diskPath).toBeUndefined();
    pending.get("/a")!(final);
    await first;
    expect(readyPath).toBe(final.relativePath);
    expect(b.diskPath).toContain("/shared/");
    unsubscribe();
  });

  it("shares an in-flight upload for the exact workspace and attachment", async () => {
    let finish!: (value: typeof final) => void;
    write.mockImplementation((args) =>
      args.base64 === ""
        ? Promise.resolve({ ...final, pending: true, bytes: 0 })
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const a = attachment();
    const first = ensureFileAttachment("/repo", a);
    const second = ensureFileAttachment("/repo", a);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    finish(final);
    expect(await first).toEqual(final);
    expect(await second).toEqual(final);
    expect(a.diskPath).toBe(final.relativePath);
  });

  it("never sends more than one bounded chunk and waits for completion", async () => {
    const size = ATTACHMENT_CHUNK_BYTES * 2 + 3;
    const a = attachment({
      size,
      sourceFile: new Blob([new Uint8Array(size)]),
    });
    write.mockImplementation(async (args) => ({
      ...final,
      bytes: Math.min(
        args.offset + (args.base64 ? ATTACHMENT_CHUNK_BYTES : 0),
        size,
      ),
      ...(!args.base64 || args.offset + ATTACHMENT_CHUNK_BYTES < size
        ? { pending: true }
        : {}),
    }));
    await ensureFileAttachment("/repo", a);
    expect(write.mock.calls.map(([args]) => args.offset)).toEqual([
      0,
      0,
      ATTACHMENT_CHUNK_BYTES,
      ATTACHMENT_CHUNK_BYTES * 2,
    ]);
    expect(
      write.mock.calls.every(
        ([args]) =>
          Buffer.from(args.base64, "base64").length <= ATTACHMENT_CHUNK_BYTES,
      ),
    ).toBe(true);
  });

  it("resolves a restored draft from its stable id without fetching file bytes", async () => {
    await ensureFileAttachment("/repo", attachment({ sourceFile: undefined }));
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        resolve: true,
        base64: "",
        attachmentId: "att-1",
      }),
    );
  });

  it("isolates workspace uploads and aborts failures so a retry can start fresh", async () => {
    const a = attachment();
    write.mockRejectedValueOnce(new Error("disk full"));
    await expect(ensureFileAttachment("/repo", a)).rejects.toThrow(/disk full/);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ abort: true }),
    );
    await ensureFileAttachment("/other", a);
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: "/other", offset: 0 }),
    );
  });

  it("retains the source after a mid-upload disconnect and retries all bytes with a new upload id", async () => {
    const bytes = new Uint8Array(ATTACHMENT_CHUNK_BYTES + 11).fill(7);
    const a = attachment({ size: bytes.length, sourceFile: new Blob([bytes]) });
    let attempt = 0;
    write.mockImplementation(async (args) => {
      if (args.abort || (attempt === 1 && args.offset > 0)) {
        throw new Error("WebSocket connection closed");
      }
      if (!args.base64) {
        attempt += 1;
        return { ...final, bytes: 0, pending: true };
      }
      const received = args.offset + Buffer.from(args.base64, "base64").length;
      return {
        ...final,
        bytes: received,
        ...(received < bytes.length ? { pending: true } : {}),
      };
    });

    await expect(ensureFileAttachment("/repo", a)).rejects.toThrow(
      "WebSocket connection closed",
    );
    expect(getFileAttachmentProgress("/repo", a.id)?.phase).toBe("error");
    const recoveryId = a.sourceRecoveryId;
    expect(recoveryId).toEqual(expect.any(String));
    expect(a.diskPath).toBeUndefined();
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ abort: true }),
    );

    await ensureFileAttachment("/repo", a);
    const requests = write.mock.calls.map(([args]) => args);
    const starts = requests.filter((args) => !args.abort && !args.base64);
    expect(starts).toHaveLength(2);
    expect(starts[1].uploadId).not.toBe(starts[0].uploadId);
    const chunks = requests.filter(
      (args) => args.uploadId === starts[1].uploadId && args.base64,
    );
    expect(chunks.map((args) => args.offset)).toEqual([0, ATTACHMENT_CHUNK_BYTES]);
    expect(Buffer.concat(chunks.map((args) => Buffer.from(args.base64, "base64"))))
      .toEqual(Buffer.from(bytes));
    expect(requests.every((args) => args.attachmentId === a.id)).toBe(true);
    expect(a.sourceRecoveryId).toBe(recoveryId);
    expect(a.diskPath).toBe(final.relativePath);
    expect(getFileAttachmentProgress("/repo", a.id)?.phase).toBe("ready");
  });
});
