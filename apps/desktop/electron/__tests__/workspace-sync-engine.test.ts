import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SYNC_LIMITS, type SyncEntry, type SyncReadRequest, type SyncSnapshotReply, type SyncSnapshotRequest } from "@zeros/protocol/workspace-sync";
import { SyncChangedError, SyncEngine, SyncRootError, type SyncSource } from "../workspace-sync/engine";

const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const identity = { workspaceId: "11111111-1111-4111-8111-111111111111", accountId: "acct", deviceId: "22222222-2222-4222-8222-222222222222" };
const EPOCH = "6b0c0a2e-1f3a-4b5c-8d6e-7f8091a2b3c4";

async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sync-engine-"))); cleanups.push(base);
  const root = join(base, "mirror"), outside = join(base, "outside");
  await mkdir(root); await mkdir(outside); await writeFile(join(outside, "secret.txt"), "keep\n");
  return { base, root, outside };
}

/** A scripted cloud: files by path; every snapshot is answered from `replies` or as a full inventory. */
function cloud(files: Record<string, string | { symlink: string } | { text: string; mode: number }> = {}) {
  let current = { ...files };
  const reads: string[] = [], replies: SyncSnapshotReply[] = [];
  let failReadsAfter = Infinity, changeOnRead: string | undefined;
  const entry = (path: string): SyncEntry => {
    const value = current[path]!;
    if (typeof value === "object" && "symlink" in value) return { path, size: value.symlink.length, mode: 0o777, mtimeMs: 1, sha256: sha(value.symlink), symlink: value.symlink };
    const text = typeof value === "string" ? value : value.text;
    return { path, size: Buffer.byteLength(text), mode: typeof value === "string" ? 0o644 : value.mode, mtimeMs: 1, sha256: sha(text) };
  };
  const source: SyncSource = {
    snapshot: async (_request: SyncSnapshotRequest) => replies.shift() ?? { epoch: EPOCH, seq: 0, full: Object.keys(current).map(entry) },
    read: async (request: SyncReadRequest) => {
      if (reads.length >= failReadsAfter) throw new Error("connection lost");
      reads.push(request.path);
      if (changeOnRead === request.path) throw new SyncChangedError();
      const value = current[request.path];
      const text = typeof value === "string" ? value : value && "text" in value ? value.text : "";
      const bytes = Buffer.from(text).subarray(request.offset, request.offset + request.length);
      return { bytes: bytes.length, base64: bytes.toString("base64") };
    },
  };
  return { source, reads, replies, entry, set: (next: typeof files) => { current = { ...next }; },
    failAfter: (count: number) => { failReadsAfter = count; }, changeOn: (path?: string) => { changeOnRead = path; } };
}
const open = (root: string, deps = {}) => SyncEngine.open(root, identity, { sleep: async () => {}, commitEvery: 1, ...deps });

describe("sync root", () => {
  it("accepts an empty folder (Finder's .DS_Store allowed) or this workspace's earlier root, and nothing else", async () => {
    const s = await sandbox();
    await writeFile(join(s.root, ".DS_Store"), "");
    const engine = await open(s.root);
    expect(JSON.parse(await readFile(join(s.root, ".zeros-sync", "root.json"), "utf8"))).toMatchObject(identity);
    expect(engine.root).toBe(s.root);
    await expect(SyncEngine.open(s.root, { ...identity, workspaceId: "33333333-3333-4333-8333-333333333333" })).rejects.toThrow(SyncRootError);
    const busy = join(s.base, "busy"); await mkdir(busy); await writeFile(join(busy, "notes.txt"), "mine");
    await expect(open(busy)).rejects.toMatchObject({ code: "not_empty" });
    const planted = join(s.base, "planted"); await mkdir(planted); await symlink(s.outside, join(planted, ".zeros-sync"));
    await expect(open(planted)).rejects.toMatchObject({ code: "unsafe_root" });
    expect(await readdir(s.outside)).toEqual(["secret.txt"]);
  });
});

describe("sync engine", () => {
  it("mirrors files, permission bits and inside links; reports outside links, case twins and traversal; writes nothing outside the root", async () => {
    const s = await sandbox(), c = cloud({ "README.md": "hi\n", "bin/run": { text: "#!/bin/sh\n", mode: 0o755 }, "docs/link": { symlink: "../README.md" } });
    const bad = (path: string, extra: Partial<SyncEntry> = {}): SyncEntry => ({ path, size: 1, mode: 0o644, mtimeMs: 1, sha256: sha("x"), ...extra });
    c.replies.push({ epoch: EPOCH, seq: 0, full: [c.entry("README.md"), c.entry("bin/run"), c.entry("docs/link"),
      bad("readme.md"), bad("../escape"), bad("a/../../escape"), bad(".zeros-sync/state.json"), bad("/abs"),
      bad("out", { symlink: "../../outside/secret.txt" }), bad("café.txt")] });
    const result = await (await open(s.root)).pull(c.source);
    expect(result.state).toBe("in_sync");
    expect(await readFile(join(s.root, "README.md"), "utf8")).toBe("hi\n");
    expect((await stat(join(s.root, "bin/run"))).mode & 0o777).toBe(0o755);
    expect(await readlink(join(s.root, "docs/link"))).toBe("../README.md");
    expect(result.problems.map(problem => [problem.path, problem.reason]).sort()).toEqual([
      ["../escape", "invalid_path"], ["/abs", "invalid_path"], [".zeros-sync/state.json", "invalid_path"], ["a/../../escape", "invalid_path"],
      ["café.txt", "not_nfc"], ["out", "symlink_outside"], ["readme.md", "case_collision"]].sort());
    expect((await readdir(s.base)).sort()).toEqual(["mirror", "outside"]);
    expect(await readdir(s.outside)).toEqual(["secret.txt"]);
  });

  it("never writes a hook through a case or Unicode spelling of .git that APFS would open as the real .git", async () => {
    const s = await sandbox(), c = cloud({ "a.txt": "a" });
    const engine = await open(s.root);
    await mkdir(join(s.root, ".git", "hooks"), { recursive: true });
    const hook = (path: string, extra: Partial<SyncEntry> = {}): SyncEntry => ({ path, size: 9, mode: 0o755, mtimeMs: 1, sha256: sha("#!/bin/sh"), ...extra });
    c.replies.push({ epoch: EPOCH, seq: 0, full: [c.entry("a.txt"), hook(".GIT/hooks/pre-commit"), hook(".Git/config"), hook("sub/.GIT/x"), hook(".g\u200Cit/hooks/post-checkout"),
      hook(".ZEROS-SYNC/state.json"), hook("link", { symlink: ".GIT/hooks" }), hook("dir/link", { symlink: "../.Git/hooks" })] });
    const result = await engine.pull(c.source);
    expect(result.problems.map(problem => problem.reason).sort()).toEqual(["invalid_path", "invalid_path", "invalid_path", "invalid_path", "invalid_path", "symlink_outside", "symlink_outside"]);
    expect(await readdir(join(s.root, ".git", "hooks"))).toEqual([]);
    expect((await readdir(s.root)).sort()).toEqual([".git", ".zeros-sync", "a.txt"]);
  });

  it("never writes through a parent that became a symlink, even to a path it mirrored before", async () => {
    const s = await sandbox(), c = cloud({ "dir/file.txt": "one\n" });
    const engine = await open(s.root);
    await engine.pull(c.source);
    await rm(join(s.root, "dir"), { recursive: true }); await symlink(s.outside, join(s.root, "dir"));
    c.set({ "dir/file.txt": "two\n", "dir/new.txt": "new\n" });
    c.replies.push({ epoch: EPOCH, seq: 1, changes: [c.entry("dir/file.txt"), c.entry("dir/new.txt")], deletes: [] });
    const result = await engine.pull(c.source);
    // Entries are applied concurrently, so the two refusals arrive in either order.
    expect([...result.problems].sort((a, b) => a.path.localeCompare(b.path)))
      .toEqual([{ path: "dir/file.txt", reason: "unsafe_parent" }, { path: "dir/new.txt", reason: "unsafe_parent" }]);
    expect(await readdir(s.outside)).toEqual(["secret.txt"]);
  });

  it("applies changes and deletes only to paths it wrote, keeps local edits in overwritten first, and leaves local-only files alone", async () => {
    const s = await sandbox(), c = cloud({ "a.txt": "a1\n", "b.txt": "b1\n", "sub/c.txt": "c1\n", "d.txt": "d1\n" });
    const engine = await open(s.root);
    await engine.pull(c.source);
    await writeFile(join(s.root, "a.txt"), "my edit\n");             // edited, then overwritten by the cloud
    await writeFile(join(s.root, "d.txt"), "my other edit\n");       // edited, then deleted by the cloud
    await writeFile(join(s.root, "mine.txt"), "local only\n");       // never synced
    c.set({ "a.txt": "a2\n", "b.txt": "b1\n", "mine.txt": "cloud wants this path\n" });
    c.replies.push({ epoch: EPOCH, seq: 1, changes: [c.entry("a.txt"), c.entry("mine.txt")], deletes: ["sub/c.txt", "d.txt", "never-synced.txt"] });
    const result = await engine.pull(c.source);
    expect(await readFile(join(s.root, "a.txt"), "utf8")).toBe("a2\n");
    expect(await readFile(join(s.root, "mine.txt"), "utf8")).toBe("local only\n");
    expect(result.problems).toEqual([{ path: "mine.txt", reason: "local_file" }]);
    await expect(lstat(join(s.root, "sub"))).rejects.toThrow();        // emptied directory removed
    await expect(lstat(join(s.root, "d.txt"))).rejects.toThrow();
    const kept = join(s.root, ".zeros-sync", "overwritten"), [stamp] = await readdir(kept);
    expect((await readdir(join(kept, stamp!))).sort()).toEqual(["a.txt", "d.txt"]);
    expect(await readFile(join(kept, stamp!, "a.txt"), "utf8")).toBe("my edit\n");
    expect(engine.position).toMatchObject({ epoch: EPOCH, seq: 1 });
  });

  it("resumes after a crash from state.json without fetching files it already wrote", async () => {
    const s = await sandbox(), c = cloud({ "1.txt": "1", "2.txt": "2", "3.txt": "3", "4.txt": "4" });
    c.failAfter(2);
    await expect((await open(s.root)).pull(c.source)).rejects.toThrow("connection lost");
    // Files are written several at a time, so which two landed first varies; the rest are never fetched twice.
    const first = [...c.reads];
    expect(first).toHaveLength(2);
    expect(await readdir(join(s.root, ".zeros-sync", "tmp"))).toEqual([]);
    c.failAfter(Infinity);
    const reopened = await open(s.root);
    expect(reopened.position).toMatchObject({ files: 2 });
    expect((await reopened.pull(c.source)).state).toBe("in_sync");
    expect([...c.reads].sort()).toEqual(["1.txt", "2.txt", "3.txt", "4.txt"]);
    expect(c.reads.slice(2).some(path => first.includes(path))).toBe(false);
    expect(await readFile(join(s.root, "4.txt"), "utf8")).toBe("4");
  });

  it("puts nothing in place when the cloud changes mid-download or a chunk does not match its sha256", async () => {
    const s = await sandbox(), c = cloud({ "a.txt": "a" });
    c.changeOn("a.txt");
    const engine = await open(s.root);
    expect((await engine.pull(c.source)).state).toBe("retry");
    await expect(lstat(join(s.root, "a.txt"))).rejects.toThrow();
    c.changeOn(undefined);
    c.replies.push({ epoch: EPOCH, seq: 0, full: [{ ...c.entry("a.txt"), sha256: sha("something else") }] });
    expect((await engine.pull(c.source)).state).toBe("retry");
    await expect(lstat(join(s.root, "a.txt"))).rejects.toThrow();
    expect(await readdir(join(s.root, ".zeros-sync", "tmp"))).toEqual([]);
  });

  it("reads a paged full inventory to the end, and starts over when a page belongs to another view", async () => {
    const s = await sandbox(), c = cloud({ "a.txt": "a", "b.txt": "b" });
    c.replies.push({ epoch: EPOCH, seq: 4, full: [c.entry("a.txt")], nextPage: "p:1" }, { epoch: EPOCH, seq: 4, full: [c.entry("b.txt")] });
    const engine = await open(s.root);
    expect((await engine.pull(c.source)).state).toBe("in_sync");
    expect((await readdir(s.root)).sort()).toEqual([".zeros-sync", "a.txt", "b.txt"]);
    c.replies.push({ epoch: "7b0c0a2e-1f3a-4b5c-8d6e-7f8091a2b3c4", seq: 0, full: [c.entry("a.txt")], nextPage: "p:1" }, { epoch: EPOCH, seq: 9, full: [c.entry("b.txt")] });
    expect((await engine.pull(c.source)).state).toBe("retry");
    expect(engine.position).toMatchObject({ epoch: EPOCH, seq: 4 });
  });

  it("keeps overwritten edits at most 7 days and 500 MB, oldest first", async () => {
    const s = await sandbox();
    let now = Date.parse("2026-11-11T10:00:00.000Z");
    const c = cloud({ "a.txt": "a1" }), engine = await open(s.root, { now: () => now, overwrittenBytes: 10 });
    await engine.pull(c.source);
    for (const [index, text] of ["edit-one!", "edit-two!", "edit-three"].entries()) {
      await writeFile(join(s.root, "a.txt"), text); await utimes(join(s.root, "a.txt"), new Date(now), new Date(now + index));
      c.set({ "a.txt": `a${index + 2}` });
      c.replies.push({ epoch: EPOCH, seq: index + 1, changes: [c.entry("a.txt")], deletes: [] });
      await engine.pull(c.source);
      now += 60_000;
    }
    const kept = join(s.root, ".zeros-sync", "overwritten");
    // 10 bytes allowed: only the newest edit survives.
    expect(await readdir(kept)).toHaveLength(1);
    expect(await readFile(join(kept, (await readdir(kept))[0]!, "a.txt"), "utf8")).toBe("edit-three");
    now += 8 * 86_400_000;
    c.replies.push({ epoch: EPOCH, seq: 3, changes: [], deletes: [] });
    await engine.pull(c.source);
    expect(await readdir(kept)).toEqual([]);
  });

  it("paces downloads to its byte rate", async () => {
    const s = await sandbox(), c = cloud({ "big.txt": "x".repeat(3000) });
    const sleeps: number[] = [];
    const engine = await open(s.root, { now: () => 0, sleep: async (ms: number) => { sleeps.push(ms); }, paceBytesPerSecond: 1000 });
    await engine.pull(c.source);
    expect(sleeps.at(-1)).toBe(3000);
  });

  it("fetches small files in batches with several requests in flight, and lands the rest when one file changed", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 2_000; index++) files[`dir${index % 20}/file${index}.txt`] = `content ${index}\n`;
    files["big.bin"] = "b".repeat(SYNC_LIMITS.batchFileBytes + 1);
    const s = await sandbox(), c = cloud(files);
    let calls = 0, active = 0, peak = 0, changed: string | undefined = "dir3/file3.txt";
    const batched: SyncSource = { ...c.source,
      batching: () => true,
      readBatch: async ({ files: wanted }) => {
        calls++; active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active--;
        return { entries: wanted.map(({ path }) => path === changed ? { path, changed: true as const }
          : { path, bytes: Buffer.byteLength(files[path]!), base64: Buffer.from(files[path]!).toString("base64") }) };
      } };
    const engine = await open(s.root);
    const first = await engine.pull(batched);
    // 2,000 small files in a handful of batches (512 per request), the big one by chunked reads.
    expect(calls).toBeLessThanOrEqual(Math.ceil(2_000 / SYNC_LIMITS.batchFiles) + 1);
    expect(peak).toBeGreaterThan(1);
    expect(c.reads).toEqual(["big.bin", "big.bin"]);   // 1 MiB + 1 byte: two chunks of at most 1 MiB
    // The changed file did not land and asks for another pass; every other file did.
    expect(first.state).toBe("retry");
    await expect(lstat(join(s.root, "dir3/file3.txt"))).rejects.toThrow();
    expect(await readFile(join(s.root, "dir4/file4.txt"), "utf8")).toBe("content 4\n");
    expect(engine.position.files).toBe(2_000);
    changed = undefined;
    calls = 0;
    expect((await engine.pull(batched)).state).toBe("in_sync");
    expect(calls).toBe(1);
    expect(await readFile(join(s.root, "dir3/file3.txt"), "utf8")).toBe("content 3\n");
    // Lands 2,000 real files twice: about 10 s alone, and past the 20 s default
    // on a CI shard that runs hundreds of files beside it.
  }, 90_000);

  it("asks again for files a batch reply left out (its byte budget), and reads one by one from a worker without batches", async () => {
    const s = await sandbox(), c = cloud({ "a.txt": "a", "b.txt": "b", "c.txt": "c" });
    const asked: string[][] = [];
    const partial: SyncSource = { ...c.source, batching: () => true,
      readBatch: async ({ files }) => { asked.push(files.map(file => file.path));
        const [first] = files; return { entries: [{ path: first!.path, bytes: 1, base64: Buffer.from(first!.path[0]!).toString("base64") }] }; } };
    expect((await (await open(s.root)).pull(partial)).state).toBe("in_sync");
    expect(asked.flat().sort()).toEqual(expect.arrayContaining(["a.txt", "b.txt", "c.txt"]));
    expect(await readFile(join(s.root, "c.txt"), "utf8")).toBe("c");
    const t = await sandbox(), d = cloud({ "a.txt": "a", "b.txt": "b" });
    expect((await (await open(t.root)).pull({ ...d.source, batching: () => false, readBatch: async () => { throw new Error("not served"); } })).state).toBe("in_sync");
    expect(d.reads.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("builds the clone before the files on a first sync, so a long first sync is already a Git folder", async () => {
    const s = await sandbox(), c = cloud({ "a.txt": "a" });
    const order: string[] = [];
    const head = { branch: "main", sha: "a".repeat(40) };
    c.replies.push({ epoch: EPOCH, seq: 0, full: [c.entry("a.txt")], head });
    const git = { available: async () => true, apply: async () => { order.push("git"); return { head: head.sha, branch: head.branch, created: [head.branch] }; } };
    const source: SyncSource = { ...c.source, read: async request => { order.push("read"); return c.source.read(request); },
      bootstrap: async () => ({ branch: head.branch, head: head.sha, remoteUrl: null }), bundleRead: async () => ({ bytes: 0, base64: "" }) };
    const result = await (await open(s.root, { git })).pull(source);
    expect(result).toMatchObject({ state: "in_sync", git: "ok" });
    expect(order).toEqual(["git", "read"]);
  });

  it("keeps at most 2 MiB requested in flight (batches of at most 1 MiB, chunks of at most 1 MiB), so an older worker's 4 MiB send buffer never fills", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 60; index++) files[`small/${index}.txt`] = "s".repeat(200 * 1024);
    files["big.bin"] = "b".repeat(5 * 1024 * 1024);
    const s = await sandbox(), c = cloud(files);
    let inFlight = 0, peak = 0, largestBatch = 0, largestChunk = 0;
    const track = async <T>(bytes: number, work: () => Promise<T>) => {
      inFlight += bytes; peak = Math.max(peak, inFlight);
      try { await new Promise(resolve => setTimeout(resolve, 2)); return await work(); } finally { inFlight -= bytes; }
    };
    const source: SyncSource = { ...c.source, batching: () => true,
      read: request => { largestChunk = Math.max(largestChunk, request.length); return track(request.length, () => c.source.read(request)); },
      readBatch: async ({ files: wanted }) => {
        const bytes = wanted.reduce((sum, file) => sum + Buffer.byteLength(files[file.path]!), 0);
        largestBatch = Math.max(largestBatch, bytes);
        return track(bytes, async () => ({ entries: wanted.map(({ path }) => ({ path, bytes: Buffer.byteLength(files[path]!), base64: Buffer.from(files[path]!).toString("base64") })) }));
      } };
    expect((await (await open(s.root)).pull(source)).state).toBe("in_sync");
    expect(largestBatch).toBeLessThanOrEqual(1024 * 1024);
    expect(largestChunk).toBeLessThanOrEqual(1024 * 1024);
    expect(peak).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(await readFile(join(s.root, "big.bin"), "utf8")).toHaveLength(5 * 1024 * 1024);
  });
});
