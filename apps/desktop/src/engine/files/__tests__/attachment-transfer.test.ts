import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ATTACHMENT_CHUNK_BYTES,
  MAX_ATTACHMENT_BYTES,
} from "@zeros/protocol/attachment-policy";
import {
  transferContextAttachment,
  resetAttachmentTransfersForTests,
} from "../attachment-transfer";
import { setContextGraphAttachmentShared } from "../context-graph";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-transfer-test-"));
});
afterEach(async () => {
  await resetAttachmentTransfersForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
const args = () => ({
  attachmentId: "att-1",
  uploadId: "upload-1",
  filename: "events.jsonl",
  mimeType: "application/jsonl",
});

describe("attachment chunk transfer", () => {
  it("keeps pending chunks outside a repo-valued TMPDIR and cleans them on abort", async () => {
    const privateData = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-transfer-private-"));
    vi.stubEnv("ZEROS_DATA_DIR", privateData);
    vi.spyOn(os, "tmpdir").mockReturnValue(root);
    try {
      const pending = await transferContextAttachment(root, {
        ...args(), base64: "YWJj", offset: 0, totalBytes: 6,
      });
      expect(pending.pending).toBe(true);
      expect(await fs.readdir(root)).toEqual([]);
      const privateEntries = await fs.readdir(privateData);
      expect(privateEntries.filter((entry) => entry.startsWith("zeros-attachment-"))).toHaveLength(1);
      expect(privateEntries).toContain("attachment-temporaries");
      await transferContextAttachment(root, { ...args(), base64: "", abort: true });
      expect(await fs.readdir(privateData)).toEqual(["attachment-temporaries"]);
      expect(await fs.readdir(path.join(privateData, "attachment-temporaries"))).toEqual([]);
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      await resetAttachmentTransfersForTests();
      await fs.rm(privateData, { recursive: true, force: true });
    }
  });

  it("publishes only the complete file and resolves the current scope without reading its contents", async () => {
    const first = await transferContextAttachment(root, {
      ...args(),
      base64: Buffer.from("abc").toString("base64"),
      offset: 0,
      totalBytes: 6,
    });
    expect(first.pending).toBe(true);
    await expect(
      transferContextAttachment(root, { ...args(), base64: "", resolve: true }),
    ).rejects.toThrow(/not available/);
    const final = await transferContextAttachment(root, {
      ...args(),
      base64: Buffer.from("def").toString("base64"),
      offset: 3,
      totalBytes: 6,
    });
    expect(final.pending).toBeUndefined();
    expect(await fs.readFile(final.absolutePath, "utf8")).toBe("abcdef");
    await setContextGraphAttachmentShared(root, "att-1", true);
    const resolved = await transferContextAttachment(root, {
      ...args(),
      base64: "",
      resolve: true,
    });
    expect(resolved.relativePath).toContain(
      "shared/attachments/att-1/events.jsonl",
    );
    expect(resolved.bytes).toBe(6);
  });

  it("streams files beyond the old 5 MiB cap in bounded chunks", async () => {
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES, 42);
    let result;
    for (let offset = 0; offset < bytes.length * 6; offset += bytes.length) {
      result = await transferContextAttachment(root, {
        ...args(),
        base64: bytes.toString("base64"),
        offset,
        totalBytes: bytes.length * 6,
      });
    }
    expect((await fs.stat(result!.absolutePath)).size).toBe(bytes.length * 6);
  });

  it("accepts a declared 500 MB file but refuses one byte more before allocating an upload", async () => {
    expect(
      (
        await transferContextAttachment(root, {
          ...args(),
          base64: "YQ==",
          offset: 0,
          totalBytes: MAX_ATTACHMENT_BYTES,
        })
      ).pending,
    ).toBe(true);
    await expect(
      transferContextAttachment(root, {
        ...args(),
        uploadId: "other",
        base64: "YQ==",
        offset: 0,
        totalBytes: MAX_ATTACHMENT_BYTES + 1,
      }),
    ).rejects.toThrow(/500 MB/);
  });

  it("checks order, ownership, metadata and encoded chunk size", async () => {
    await transferContextAttachment(root, {
      ...args(),
      base64: "YQ==",
      offset: 0,
      totalBytes: 2,
    });
    await expect(
      transferContextAttachment(root, {
        ...args(),
        base64: "Yg==",
        offset: 0,
        totalBytes: 2,
      }),
    ).rejects.toThrow(/offset/);
    await expect(
      transferContextAttachment(root, {
        ...args(),
        attachmentId: "att-other",
        base64: "Yg==",
        offset: 1,
        totalBytes: 2,
      }),
    ).rejects.toThrow(/metadata/);
    await expect(
      transferContextAttachment(root, {
        ...args(),
        uploadId: "too-big",
        base64: "A".repeat(ATTACHMENT_CHUNK_BYTES * 2),
        offset: 0,
        totalBytes: MAX_ATTACHMENT_BYTES,
      }),
    ).rejects.toThrow(/chunk/);
  });

  it.each(["report.zip", "installer.apk", "disk.dmg", "app.exe"])(
    "refuses %s at the engine boundary",
    async (filename) => {
      await expect(
        transferContextAttachment(root, {
          ...args(),
          filename,
          base64: "YQ==",
          offset: 0,
          totalBytes: 1,
        }),
      ).rejects.toThrow(/aren't supported/);
    },
  );

  it("aborts an incomplete transfer without publishing a graph record", async () => {
    await transferContextAttachment(root, {
      ...args(),
      base64: "YQ==",
      offset: 0,
      totalBytes: 2,
    });
    await transferContextAttachment(root, {
      ...args(),
      base64: "",
      abort: true,
    });
    await expect(
      transferContextAttachment(root, {
        ...args(),
        base64: "Yg==",
        offset: 1,
        totalBytes: 2,
      }),
    ).rejects.toThrow(/not found/);
  });

  it("accepts empty files and refuses symlinked graph directories", async () => {
    const result = await transferContextAttachment(root, {
      ...args(),
      base64: "",
      offset: 0,
      totalBytes: 0,
    });
    expect((await fs.stat(result.absolutePath)).size).toBe(0);
    await fs.rm(path.join(root, ".context"), { recursive: true });
    await fs.symlink(os.tmpdir(), path.join(root, ".context"));
    await expect(
      transferContextAttachment(root, {
        ...args(),
        uploadId: "second",
        base64: "YQ==",
        offset: 0,
        totalBytes: 1,
      }),
    ).rejects.toThrow();
  });
});
