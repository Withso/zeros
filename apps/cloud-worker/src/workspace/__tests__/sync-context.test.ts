import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncSnapshotReply } from "@zeros/protocol/workspace-sync";
import { commandRunner } from "../commands";
import { SyncService } from "../sync-service";
import { repositoryFixture } from "./repository-fixture";

const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture(contextLimits: { files?: number; bytes?: number } = {}) {
  const f = await repositoryFixture();
  await writeFile(join(f.root, ".gitignore"), "node_modules/\n*.log\n.context/\n");
  await f.git("add", ".gitignore"); await f.git("commit", "-m", "ignore");
  const bundles = await mkdtemp(join(tmpdir(), "sync-bundles-")); cleanups.push(bundles);
  const sync = new SyncService(f.scope, commandRunner(f.root), () => {}, { bundleDirectory: bundles, contextLimits });
  const put = async (path: string, text = "x") => { await mkdir(join(f.root, path, ".."), { recursive: true }); await writeFile(join(f.root, path), text); };
  const snapshot = async (params: Record<string, unknown> = {}) => await sync.handle("sync.snapshot", params) as SyncSnapshotReply;
  const paths = (reply: SyncSnapshotReply) => (reply.full ?? []).map(entry => entry.path);
  return { ...f, sync, put, snapshot, paths };
}

describe("what syncs from .context (contract 12.x / 12.y)", () => {
  it("syncs .context although Git ignores it, and still never other ignored files, attachments, nested repos, ignored paths or symlinks", async () => {
    const f = await fixture();
    await f.put("debug.log"); await f.put("node_modules/pkg/index.js");
    await f.put(".context/notes.md", "plan\n"); await f.put(".context/todos/a.md");
    await f.put(".context/attachments/photo.png");
    await f.put(".context/nested/.git/HEAD", "ref: refs/heads/main\n"); await f.put(".context/nested/file.txt");
    await f.put(".context/linked/.git", "gitdir: /elsewhere\n"); await f.put(".context/linked/x.txt");
    await f.put(".context/x/node_modules/dep.js"); await f.put(".context/x/build.log"); await f.put(".context/x/kept.ts");
    await f.put(".context/x/.GIT/config");
    await symlink("../readme.txt", join(f.root, ".context", "link.md"));
    const reply = await f.snapshot();
    expect(f.paths(reply).filter(path => path.startsWith(".context/"))).toEqual([".context/notes.md", ".context/todos/a.md", ".context/x/kept.ts"]);
    for (const absent of ["debug.log", "node_modules/pkg/index.js"]) expect(f.paths(reply)).not.toContain(absent);
    expect(reply.skipped ?? []).not.toContainEqual(expect.objectContaining({ reason: "context_limit" }));
  });

  it("gives .context its own budget in walk order: the overflow is reported once, an earlier-sorted new file evicts the last as a delete, and the rest keeps syncing", async () => {
    const f = await fixture({ files: 3 });
    for (const name of ["b", "c", "d", "e"]) await f.put(`.context/${name}.md`);
    const first = await f.snapshot();
    expect(f.paths(first).filter(path => path.startsWith(".context/"))).toEqual([".context/b.md", ".context/c.md", ".context/d.md"]);
    expect(f.paths(first)).toContain("readme.txt");
    expect(first.skipped).toEqual([{ path: ".context", reason: "context_limit" }]);
    await f.put(".context/a.md");
    await (f.sync as unknown as { tracker: { refresh(): Promise<boolean> } }).tracker.refresh();
    const next = await f.snapshot({ epoch: first.epoch, seq: first.seq });
    expect(next.changes!.map(entry => entry.path)).toEqual([".context/a.md"]);
    expect(next.deletes).toEqual([".context/d.md"]);
    await unlink(join(f.root, ".context", "a.md"));
  });

  it("stops at the byte budget too", async () => {
    const f = await fixture({ bytes: 5 });
    await f.put(".context/a.md", "123"); await f.put(".context/b.md", "456");
    const reply = await f.snapshot();
    expect(f.paths(reply).filter(path => path.startsWith(".context/"))).toEqual([".context/a.md"]);
    expect(reply.skipped).toEqual([{ path: ".context", reason: "context_limit" }]);
  });
});
