import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SyncSnapshotReplySchema, isSyncLinkTarget as insideRoot } from "@zeros/protocol/workspace-sync";
import { SyncTracker } from "../sync-tracker";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture(limits: ConstructorParameters<typeof SyncTracker>[0]["limits"] = {}) {
  const root = await mkdtemp(join(tmpdir(), "sync-tracker-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  let listed: string[] = [];
  let now = 1_000_000;
  const tracker = new SyncTracker({ root, list: async () => listed, now: () => now, limits });
  const put = async (path: string, text: string) => { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); if (!listed.includes(path)) listed.push(path); };
  const remove = async (path: string) => { await unlink(join(root, path)); listed = listed.filter(item => item !== path); };
  return { root, tracker, put, remove, list: (paths: string[]) => { listed = paths; }, advance: (ms: number) => { now += ms; } };
}

describe("SyncTracker", () => {
  it("answers a first full inventory, then only the changes since a seq of the same epoch", async () => {
    const f = await fixture();
    await f.put("README.md", "hello\n"); await f.put("src/app.ts", "export {};\n");
    const first = await f.tracker.snapshot({});
    expect(SyncSnapshotReplySchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({ seq: 0, full: [{ path: "README.md", size: 6, sha256: sha("hello\n") }, { path: "src/app.ts" }] });
    expect(first.resyncReason).toBeUndefined();
    await f.put("README.md", "hello again\n"); await f.remove("src/app.ts"); await f.put("src/new.ts", "1\n");
    expect(await f.tracker.refresh()).toBe(true);
    const next = await f.tracker.snapshot({ epoch: first.epoch, seq: 0 });
    expect(next).toEqual({ epoch: first.epoch, seq: 1, changes: [expect.objectContaining({ path: "README.md", sha256: sha("hello again\n") }),
      expect.objectContaining({ path: "src/new.ts" })], deletes: ["src/app.ts"] });
    expect(await f.tracker.snapshot({ epoch: first.epoch, seq: 1 })).toEqual({ epoch: first.epoch, seq: 1, changes: [], deletes: [] });
    // Touching nothing records nothing.
    expect(await f.tracker.refresh()).toBe(false);
    expect(f.tracker.seq).toBe(1);
  });

  it("answers an unknown epoch, a future seq and a seq older than the retained deltas with a full inventory and its reason", async () => {
    const f = await fixture({ retainedDeltas: 2 });
    await f.put("a.txt", "0");
    const { epoch } = await f.tracker.snapshot({});
    for (const text of ["1", "2", "3"]) { await f.put("a.txt", text); await f.tracker.refresh(); }
    expect(f.tracker.seq).toBe(3);
    expect(await f.tracker.snapshot({ epoch, seq: 0 })).toMatchObject({ full: [{ path: "a.txt" }], resyncReason: "retention_gap" });
    expect(await f.tracker.snapshot({ epoch, seq: 1 })).toMatchObject({ changes: [{ path: "a.txt", sha256: sha("3") }] });
    expect(await f.tracker.snapshot({ epoch: "6b0c0a2e-1f3a-4b5c-8d6e-7f8091a2b3c4", seq: 3 })).toMatchObject({ resyncReason: "unknown_epoch", full: [{ path: "a.txt" }] });
    expect(await f.tracker.snapshot({ epoch, seq: 9 })).toMatchObject({ resyncReason: "unknown_epoch" });
  });

  it("starts a new epoch when the watcher loses events, so every Mac re-reads everything", async () => {
    const f = await fixture();
    await f.put("a.txt", "0");
    const before = await f.tracker.snapshot({});
    f.tracker.lossy();
    const after = await f.tracker.snapshot({ epoch: before.epoch, seq: before.seq });
    expect(after.epoch).not.toBe(before.epoch);
    expect(after).toMatchObject({ resyncReason: "unknown_epoch", full: [{ path: "a.txt" }] });
  });

  it("pages a full inventory from a frozen copy that later changes cannot tear, and expires an abandoned page", async () => {
    const f = await fixture({ pageEntries: 2 });
    for (const name of ["a", "b", "c", "d", "e"]) await f.put(`${name}.txt`, name);
    const first = await f.tracker.snapshot({});
    expect(first.full!.map(entry => entry.path)).toEqual(["a.txt", "b.txt"]);
    await f.put("a.txt", "changed"); await f.put("aa.txt", "new"); await f.tracker.refresh();
    const second = await f.tracker.snapshot({ page: first.nextPage! });
    const third = await f.tracker.snapshot({ page: second.nextPage! });
    expect([second, third].map(reply => reply.full!.map(entry => entry.path))).toEqual([["c.txt", "d.txt"], ["e.txt"]]);
    expect(third.nextPage).toBeUndefined();
    expect([second.seq, third.seq, third.epoch]).toEqual([0, 0, first.epoch]);
    // Then the changes since the frozen seq bring the Mac current.
    expect(await f.tracker.snapshot({ epoch: first.epoch, seq: 0 })).toMatchObject({ changes: [{ path: "a.txt" }, { path: "aa.txt" }] });
    const again = await f.tracker.snapshot({});
    f.advance(120_001);
    expect(await f.tracker.snapshot({ page: again.nextPage! })).toMatchObject({ resyncReason: "page_expired", full: [{ path: "a.txt" }, { path: "aa.txt" }] });
    expect(await f.tracker.snapshot({ page: "forged:3" })).toMatchObject({ resyncReason: "page_expired" });
  });

  it("mirrors a symlink only when it resolves inside the checkout, keeps permission bits, and lists what it skipped", async () => {
    const f = await fixture({ fileBytes: 8 });
    await f.put("bin/run.sh", "echo 1\n"); await chmod(join(f.root, "bin/run.sh"), 0o755);
    await f.put("big.bin", "123456789");
    await symlink("../bin/run.sh", join(f.root, "bin", "link")); await symlink("/etc/passwd", join(f.root, "abs"));
    await symlink("../../outside", join(f.root, "bin", "escape"));
    await mkdir(join(f.root, "vendor", "module"), { recursive: true });
    f.list(["bin/run.sh", "big.bin", "bin/link", "abs", "bin/escape", "vendor/module", ".git/config", "../up.txt", "gone.txt"]);
    const reply = await f.tracker.snapshot({});
    expect(reply.full!.map(entry => [entry.path, entry.symlink ?? null])).toEqual([["bin/link", "../bin/run.sh"], ["bin/run.sh", null]]);
    expect(reply.full!.find(entry => entry.path === "bin/run.sh")!.mode).toBe(0o755);
    expect(reply.skipped).toEqual([{ path: "abs", reason: "symlink_outside" }, { path: "big.bin", reason: "too_large" },
      { path: "bin/escape", reason: "symlink_outside" }, { path: "vendor/module", reason: "unsupported" }]);
  });

  it("stops with a visible reason past the file or byte caps", async () => {
    const files = await fixture({ totalFiles: 2 });
    for (const name of ["a", "b", "c"]) await files.put(`${name}.txt`, name);
    expect(await files.tracker.snapshot({})).toEqual({ epoch: files.tracker.epoch, seq: 0, stopped: "too_many_files" });
    const bytes = await fixture({ totalBytes: 3 });
    await bytes.put("a.txt", "ab"); await bytes.put("b.txt", "cd");
    expect(await bytes.tracker.snapshot({})).toMatchObject({ stopped: "too_many_bytes" });
  });

  it("judges link targets lexically from the link's directory", () => {
    expect(insideRoot("a/b/link", "../c")).toBe(true);
    expect(insideRoot("a/link", "../../x")).toBe(false);
    expect(insideRoot("link", "/etc")).toBe(false);
    expect(insideRoot("a/link", "../.git/config")).toBe(false);
    // A link to the root itself would loop: never mirrored.
    expect(insideRoot("a/link", "..")).toBe(false);
    expect(insideRoot("link", ".")).toBe(false);
  });
});
