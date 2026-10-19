import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudFinalSaveJournal, CLOUD_FINAL_SAVE_BODY_BYTES, finalSaveCommitDescriptor } from "../cloud-final-save-journal";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const data = await fs.mkdtemp(path.join(tmpdir(), "zeros-final-journal-control-")); roots.push(data);
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(), origin: "https://api.example.test" };
  const attempt = { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 60_000 };
  const body = JSON.stringify({ ...scope, requestId: attempt.id, idempotencyKey: `checkpoint.${attempt.id}.commit`,
    contentRevision: 1, reason: attempt.reason, manifestBlobId: randomUUID(), artifactBlobId: null, inclusionPolicy: {},
    fileCount: 0, totalBytes: 0, integritySha256: "a".repeat(64) });
  return { data, scope, attempt, body, journal: new CloudFinalSaveJournal(data),
    file: path.join(data, "final-save-commits", `${scope.engineInstanceId}.json`) };
}

describe.runIf(process.platform === "linux")("private final-save commit journal", () => {
  it("fsyncs file and both directory entries before exposing a frozen exact body", async () => {
    const f = await fixture(), operations: string[] = [], open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (name, ...args) => {
      const handle = await open(name, ...args), sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { operations.push(String(name).endsWith(".tmp") ? "body" : String(name) === f.data ? "parent" : "directory"); await sync(); });
      return handle;
    });
    const record = await f.journal.prepare(f.scope, f.attempt, f.body);
    expect(operations).toEqual(expect.arrayContaining(["parent", "body", "directory"]));
    expect(operations.indexOf("body")).toBeLessThan(operations.lastIndexOf("directory"));
    expect((await fs.stat(f.file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(f.file))).mode & 0o777).toBe(0o700);
    expect(Object.isFrozen(record)).toBe(true); expect(Object.isFrozen(record.scope)).toBe(true);
    expect((await f.journal.read(f.scope, f.attempt))!.body).toBe(f.body);
    await f.journal.resolve(f.scope, f.attempt);
    expect(await f.journal.read(f.scope, f.attempt)).toBeNull();
  });

  it.each(["parent", "body", "directory"] as const)("never dispatches or re-prepares after a failed %s fsync", async boundary => {
    const f = await fixture(), open = fs.open.bind(fs);
    let failed = false;
    vi.spyOn(fs, "open").mockImplementation(async (name, ...args) => {
      const handle = await open(name, ...args), sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        const kind = String(name).endsWith(".tmp") ? "body" : String(name) === f.data ? "parent" : "directory";
        if (!failed && kind === boundary) { failed = true; throw new Error("synthetic persistence failure"); }
        await sync();
      });
      return handle;
    });
    await expect(f.journal.prepare(f.scope, f.attempt, f.body)).rejects.toThrow(/journal/);
    expect(failed).toBe(true);
    await expect(f.journal.prepare(f.scope, f.attempt, f.body)).rejects.toThrow(/journal/);
  });

  it.each(["missing", "corrupt", "mode", "hardlink", "symlink", "oversize"] as const)("refuses %s journal evidence without adopting or recapturing it", async change => {
    const f = await fixture(); await f.journal.prepare(f.scope, f.attempt, f.body);
    if (change === "missing") await fs.unlink(f.file);
    if (change === "corrupt") await fs.writeFile(f.file, "{}");
    if (change === "mode") await fs.chmod(f.file, 0o644);
    if (change === "hardlink") await fs.link(f.file, path.join(f.data, "extra"));
    if (change === "symlink") { await fs.rename(f.file, `${f.file}.original`); await fs.symlink(`${f.file}.original`, f.file); }
    if (change === "oversize") await fs.truncate(f.file, CLOUD_FINAL_SAVE_BODY_BYTES * 2 + 1);
    await expect(f.journal.read(f.scope, f.attempt)).rejects.toThrow(/journal/);
    await expect(f.journal.prepare(f.scope, f.attempt, f.body)).rejects.toThrow(/journal/);
    if (change !== "missing") await expect(new CloudFinalSaveJournal(f.data).read(f.scope, f.attempt)).rejects.toThrow(/journal/);
  });

  it("refuses a real private FIFO without waiting for an external writer or abandoning its read", async () => {
    const f = await fixture(); await f.journal.prepare(f.scope, f.attempt, f.body);
    await fs.unlink(f.file);
    await promisify(execFile)("mkfifo", ["-m", "600", f.file]);
    const open = fs.open.bind(fs);
    let entered!: () => void;
    const opening = new Promise<void>(resolve => { entered = resolve; });
    let leaf: FileHandle | undefined;
    let byteReads = () => 0;
    vi.spyOn(fs, "open").mockImplementation(async (name, ...args) => {
      const isLeaf = String(name).endsWith(`/${f.scope.engineInstanceId}.json`);
      if (isLeaf) entered();
      const handle = await open(name, ...args);
      if (isLeaf) {
        leaf = handle;
        const reads = vi.spyOn(handle, "read");
        byteReads = () => reads.mock.calls.length;
      }
      return handle;
    });
    let settled = false, refused = false, refusedWithoutWriter = false;
    const read = f.journal.read(f.scope, f.attempt).then(
      () => { settled = true; },
      error => { settled = true; refused = /journal/.test(String(error)); },
    );
    let writer: FileHandle | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await opening;
      // Observe the actual open before bounding the negative check. The writer
      // stays absent throughout; cleanup below joins even the broken reader.
      await Promise.race([read, new Promise<void>(resolve => { timer = setTimeout(resolve, 250); })]);
      refusedWithoutWriter = settled && refused;
    } finally {
      clearTimeout(timer);
      if (!settled) writer = await open(f.file, constants.O_RDWR | constants.O_NONBLOCK);
      try { await read; } finally { await writer?.close(); }
    }
    expect(refused).toBe(true);
    expect(byteReads()).toBe(0);
    expect(leaf?.fd).toBe(-1);
    expect(refusedWithoutWriter).toBe(true);
  });

  it("rejects an exposed or replaced directory, another attempt and an oversized body", async () => {
    const f = await fixture();
    await fs.mkdir(path.dirname(f.file), { mode: 0o755 });
    await expect(f.journal.read(f.scope, f.attempt)).rejects.toThrow(/journal/);
    await fs.chmod(path.dirname(f.file), 0o700);
    await f.journal.prepare(f.scope, f.attempt, f.body);
    await expect(f.journal.read({ ...f.scope, origin: "https://other.example.test" }, f.attempt)).rejects.toThrow(/journal/);
    await expect(f.journal.read(f.scope, { ...f.attempt, deadlineAtMs: f.attempt.deadlineAtMs + 1 })).rejects.toThrow(/journal/);
    expect(() => finalSaveCommitDescriptor(" ".repeat(CLOUD_FINAL_SAVE_BODY_BYTES + 1))).toThrow(/journal/);
  });
});
