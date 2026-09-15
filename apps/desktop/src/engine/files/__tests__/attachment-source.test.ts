import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerAttachmentSource } from "../attachment-source";
import { transferContextAttachment } from "../attachment-transfer";
import {
  stageContextGraphAttachmentFile,
  listContextGraph,
  contextGraphArchivePaths,
} from "../context-graph";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-native-attachment-"));
  vi.stubEnv("ZEROS_DATA_DIR", path.join(root, "private"));
  await fs.mkdir(path.join(root, "workspace"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function selection() {
  const source = path.join(root, "records.jsonl");
  const bytes = Buffer.from('{"text":"é"}\r\n{"n":2}\n');
  await fs.writeFile(source, bytes);
  const nativeSourceId = await registerAttachmentSource(source, bytes.length);
  const args = {
    attachmentId: "att-native",
    filename: "records.jsonl",
    mimeType: "application/jsonl",
    base64: "",
    nativeSourceId,
  };
  return { source, bytes, args };
}

it("copies a selected file byte for byte through a durable opaque source id", async () => {
  const { source, bytes, args } = await selection();
  expect(args.nativeSourceId).not.toContain(source);
  const result = await transferContextAttachment(
    path.join(root, "workspace"),
    args,
    { allowNativeSource: true },
  );
  expect(result.pending).toBeUndefined();
  expect(await fs.readFile(result.absolutePath)).toEqual(bytes);
  expect(await fs.readFile(source)).toEqual(bytes);
  await fs.unlink(source);
  const restored = await transferContextAttachment(
    path.join(root, "workspace"),
    { ...args, resolve: true },
  );
  expect(restored.relativePath).toBe(result.relativePath);
});

it("rejects native source capabilities on nonlocal transports", async () => {
  const { args } = await selection();
  await expect(
    transferContextAttachment(path.join(root, "workspace"), args),
  ).rejects.toThrow(/local/);
});

it("refuses a replaced source and never publishes a partial record", async () => {
  const { source, bytes, args } = await selection();
  await fs.unlink(source);
  await fs.writeFile(source, Buffer.alloc(bytes.length, 32));
  await expect(
    transferContextAttachment(path.join(root, "workspace"), args, {
      allowNativeSource: true,
    }),
  ).rejects.toThrow(/changed/);
  await expect(
    transferContextAttachment(path.join(root, "workspace"), {
      ...args,
      resolve: true,
    }),
  ).rejects.toThrow(/not available/);
});

it("rejects directories, forged source ids, and changed file sizes", async () => {
  await expect(registerAttachmentSource(root, 0)).rejects.toThrow(
    /regular file/,
  );
  const { source, args } = await selection();
  await expect(registerAttachmentSource(source, 999)).rejects.toThrow(
    /changed/,
  );
  await expect(
    transferContextAttachment(
      path.join(root, "workspace"),
      { ...args, nativeSourceId: "../../source" },
      { allowNativeSource: true },
    ),
  ).rejects.toThrow(/source/);
});

it("keeps an unfinished native copy out of the Context graph and archive scopes", async () => {
  const { source, bytes } = await selection();
  const workspace = path.join(root, "workspace");
  const file = await fs.open(source, "r");
  let items: unknown[] = [];
  let archivePaths: string[] = [];
  try {
    const result = await stageContextGraphAttachmentFile(workspace, {
      attachmentId: "att-pending",
      filename: "records.jsonl",
      file,
      size: bytes.length,
      verify: async () => {
        items = (await listContextGraph(workspace)).items;
        archivePaths = await contextGraphArchivePaths(workspace);
      },
    });
    expect(result.ok).toBe(true);
    expect(items).toEqual([]);
    expect(archivePaths).toEqual([]);
    expect((await listContextGraph(workspace)).items).toHaveLength(1);
  } finally {
    await file.close();
  }
});

it.each([false, true])("copies outside the workspace and cleans temporary bytes (failed=%s)", async (fail) => {
  const { source, bytes } = await selection();
  const workspace = path.join(root, "workspace");
  const file = await fs.open(source, "r");
  const open = fs.open.bind(fs);
  const temporaryPaths: string[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (typeof args[1] === "number" && (args[1] & constants.O_CREAT))
      temporaryPaths.push(String(args[0]));
    return open(...args);
  });
  try {
    const result = await stageContextGraphAttachmentFile(workspace, {
      attachmentId: "att-private",
      filename: "records.jsonl",
      file,
      size: bytes.length,
      verify: async () => {
        expect(temporaryPaths).toHaveLength(1);
        expect(path.relative(workspace, temporaryPaths[0]).startsWith(`..${path.sep}`)).toBe(true);
        expect((await fs.readdir(workspace, { recursive: true })).some((entry) => entry.includes(".staging") || entry.includes(".attachment-staging"))).toBe(false);
        if (fail) throw new Error("source changed during copy");
      },
    });
    expect(result.ok).toBe(!fail);
    if (fail) expect(result.error).toBe("source changed during copy");
    for (const temporaryPath of temporaryPaths)
      await expect(fs.lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await listContextGraph(workspace)).items).toHaveLength(fail ? 0 : 1);
  } finally {
    await file.close();
  }
});

it("finishes short filesystem reads without changing the file bytes", async () => {
  const { source, bytes } = await selection();
  const file = await fs.open(source, "r");
  const shortReads = {
    stat: () => file.stat(),
    read: (buffer: Buffer, offset: number, length: number, position: number) =>
      file.read(buffer, offset, Math.min(length, 2), position),
  } as fs.FileHandle;
  try {
    const result = await stageContextGraphAttachmentFile(
      path.join(root, "workspace"),
      {
        attachmentId: "att-short-reads",
        filename: "records.jsonl",
        file: shortReads,
        size: bytes.length,
      },
    );
    expect(result.ok).toBe(true);
    expect(await fs.readFile(result.absolutePath!)).toEqual(bytes);
  } finally {
    await file.close();
  }
});
