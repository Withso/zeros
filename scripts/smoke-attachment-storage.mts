// Exercise the production attachment storage across real process termination.
// --large copies the full 500 MB limit and, on macOS, tests a disposable APFS
// volume and an actual disk-full error. All files/children belong to this run.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerAttachmentSource,
  withAttachmentSource,
  pruneAttachmentSources,
} from "../apps/desktop/src/engine/files/attachment-source";
import { transferContextAttachment } from "../apps/desktop/src/engine/files/attachment-transfer";
import {
  stageContextGraphAttachmentFile,
  listContextGraph,
} from "../apps/desktop/src/engine/files/context-graph";
import { pruneAttachmentTemporaryDirectories } from "../apps/desktop/src/engine/files/attachment-temporary-directory";

const script = fileURLToPath(import.meta.url);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  );
const childMode = process.argv[2];
const argsFor = (id: string, attachmentId = "smoke-records") => ({
  attachmentId,
  nativeSourceId: id,
  filename: "records.jsonl",
  mimeType: "application/jsonl",
  base64: "",
});

if (childMode === "--interruptible" || childMode === "--resume") {
  const root = process.argv[3];
  const sourceId = process.argv[4];
  const workspace = path.join(root, "workspace");
  process.env.ZEROS_DATA_DIR = path.join(root, "private");
  if (childMode === "--interruptible") {
    await withAttachmentSource(sourceId, async (file, size, verify) => {
      const read = file.read.bind(file);
      let reads = 0;
      file.read = (async (...args: Parameters<typeof file.read>) => {
        if (++reads === 2) {
          await fs.writeFile(path.join(root, "copy-started"), "ready");
          await pause(60_000);
        }
        return read(...args);
      }) as typeof file.read;
      return stageContextGraphAttachmentFile(workspace, {
        attachmentId: "smoke-records",
        filename: "records.jsonl",
        file,
        size,
        verify,
      });
    });
  } else {
    console.log(
      JSON.stringify(
        await transferContextAttachment(workspace, argsFor(sourceId), {
          allowNativeSource: true,
        }),
      ),
    );
  }
} else {
  const large = process.argv.includes("--large");
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "zeros-attachment-storage-smoke-"),
  );
  const workspace = path.join(root, "workspace");
  const source = path.join(root, "original.jsonl");
  const size = large ? 500_000_000 : 8 * 1024 * 1024;
  process.env.ZEROS_DATA_DIR = path.join(root, "private");
  let running: ReturnType<typeof spawn> | undefined;
  let mounted: string | undefined;
  const result: Record<string, unknown> = {
    bytes: size,
    platform: process.platform,
  };
  const startCopy = (mode: string, sourceId: string) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, script, mode, root, sourceId],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    running = child;
    let output = "";
    child.stdout?.on("data", (chunk) => {
      if (output.length < 65_536) output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      if (output.length < 65_536) output += chunk;
    });
    const done = new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve({ code, output }));
      },
    );
    return { child, done };
  };
  const digest = async (file: string) => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  };
  try {
    const disk = await fs.statfs(root);
    assert(
      Number(disk.bavail) * Number(disk.bsize) > size * 3,
      "Insufficient free space for the isolated smoke test",
    );
    await fs.mkdir(workspace);
    const file = await fs.open(source, "wx");
    try {
      const chunk = Buffer.from('{"n":1}\n'.repeat(131_072));
      for (let written = 0; written < size; written += chunk.length)
        await file.writeFile(
          chunk.subarray(0, Math.min(chunk.length, size - written)),
        );
    } finally {
      await file.close();
    }
    assert.equal(await exists(path.join(workspace, ".context")), false);
    const sourceId = await registerAttachmentSource(source, size);
    const interrupted = startCopy("--interruptible", sourceId);
    const deadline = Date.now() + 30_000;
    while (!(await exists(path.join(root, "copy-started")))) {
      assert(
        Date.now() < deadline && interrupted.child.exitCode === null,
        "Copy did not reach its interruption checkpoint",
      );
      await pause(25);
    }
    interrupted.child.kill("SIGKILL");
    await interrupted.done;
    running = undefined;
    assert.deepEqual((await listContextGraph(workspace)).items, []);
    const registry = path.join(root, "private", "attachment-temporaries");
    const records = await fs.readdir(registry);
    assert.equal(records.length, 1);
    const recordPath = path.join(registry, records[0]);
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    await pruneAttachmentTemporaryDirectories();
    assert.equal(
      await exists(record.path),
      true,
      "Fresh crash recovery must respect the grace period",
    );
    const restarted = await startCopy("--resume", sourceId).done;
    running = undefined;
    assert.equal(restarted.code, 0, restarted.output);
    const saved = JSON.parse(restarted.output.trim());
    assert.equal(saved.bytes, size);
    assert.equal(await digest(saved.absolutePath), await digest(source));
    assert.equal(
      await exists(path.join(workspace, ".context", ".attachment-staging")),
      false,
    );
    record.createdAt = Date.now() - 2 * 86_400_000;
    await fs.writeFile(recordPath, JSON.stringify(record));
    await pruneAttachmentTemporaryDirectories();
    assert.equal(await exists(record.path), false);
    assert.equal(await exists(saved.absolutePath), true);
    result.processRestart = true;
    result.exactBytes = true;
    result.crashCleanup = true;

    if (process.platform === "darwin") {
      const image = path.join(root, "test-volume.sparseimage");
      const volume = path.join(root, "volume");
      await fs.mkdir(volume);
      execFileSync(
        "hdiutil",
        [
          "create",
          "-size",
          "128m",
          "-fs",
          "APFS",
          "-type",
          "SPARSE",
          "-volname",
          "ZerosAttachmentSmoke",
          image,
        ],
        { stdio: "pipe" },
      );
      execFileSync(
        "hdiutil",
        ["attach", image, "-nobrowse", "-mountpoint", volume],
        { stdio: "pipe" },
      );
      mounted = volume;
      const external = path.join(volume, "workspace");
      await fs.mkdir(external);
      assert.notEqual((await fs.stat(external)).dev, (await fs.stat(root)).dev);
      const small = path.join(root, "small.jsonl");
      const contents = Buffer.from('{"text":"é"}\r\n{"n":2}\n');
      await fs.writeFile(small, contents);
      const smallId = await registerAttachmentSource(small, contents.length);
      const moved = await transferContextAttachment(
        external,
        argsFor(smallId, "external-copy"),
        { allowNativeSource: true },
      );
      assert.deepEqual(await fs.readFile(moved.absolutePath), contents);
      result.separateVolume = true;
      if (large) {
        await assert.rejects(
          transferContextAttachment(
            external,
            argsFor(sourceId, "disk-full-copy"),
            { allowNativeSource: true },
          ),
          /ENOSPC|space/i,
        );
        assert.equal((await listContextGraph(external)).items.length, 1);
        assert.equal((await fs.readdir(registry)).length, 0);
        result.diskFull = true;
      }
    }

    const capability = path.join(
      root,
      "private",
      "attachment-sources",
      `${sourceId}.json`,
    );
    const old = new Date(Date.now() - 2 * 86_400_000);
    await fs.utimes(capability, old, old);
    await pruneAttachmentSources(new Set([sourceId]));
    assert.equal(await exists(capability), true);
    await pruneAttachmentSources(new Set());
    assert.equal(await exists(capability), false);
    assert.equal(await exists(source), true);
    assert.equal(await exists(saved.absolutePath), true);
    result.capabilityCleanup = true;
    console.log(JSON.stringify(result));
  } finally {
    running?.kill("SIGKILL");
    if (mounted)
      execFileSync("hdiutil", ["detach", mounted, "-force"], { stdio: "pipe" });
    await fs.rm(root, { recursive: true, force: true });
  }
}
