// Reproducible local fixture; never archives a user's workspace.
// pnpm exec tsx scripts/benchmark-workspace-archive.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  archiveWorkspace,
  closeState,
  createWorkspace,
  restoreWorkspace,
  setStateRootForTesting,
} from "../apps/desktop/src/engine/git";
import {
  snapshotWorkingTree,
  type SnapshotTimings,
} from "../apps/desktop/src/engine/git/turns-git";

const exec = promisify(execFile);
async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-archive-bench-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const git = async (cwd: string, ...args: string[]) =>
    (await exec("git", args, { cwd })).stdout;
  const rows: Array<Record<string, string | number | boolean>> = [];

  try {
    setStateRootForTesting(path.join(root, "state"));
    await mkdir(repo);
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "init", "-q", "--bare", "-b", "main", remote);
    await git(repo, "config", "user.name", "Archive benchmark");
    await git(repo, "config", "user.email", "benchmark@example.test");
    await git(repo, "remote", "add", "origin", remote);
    await mkdir(path.join(repo, "fixture"));
    const block = randomBytes(256 * 1024);
    // 512 files / 128 MiB. Repeated data keeps fixture setup inexpensive while
    // still making a cold snapshot read/hash all 128 MiB from the checkout.
    for (let index = 0; index < 512; index++) {
      await writeFile(path.join(repo, "fixture", `${index}.bin`), block);
    }
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "benchmark fixture");
    await git(repo, "push", "-qu", "origin", "main");
    await git(
      repo,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
    const workspace = await createWorkspace({
      repoRoot: repo,
      runRepoScripts: false,
    });
    const draft = "latest uncommitted draft\n";
    await writeFile(path.join(workspace.path, "draft.txt"), draft);
    for (const name of ["cold", "warm", "warm-again"]) {
      let timing: SnapshotTimings | undefined;
      const started = performance.now();
      const commit = await snapshotWorkingTree(
        workspace.path,
        `refs/zeros/benchmark/${name}`,
        {
          onTiming: (value) => {
            timing = value;
          },
        },
      );
      assert(commit, `${name} snapshot must succeed`);
      assert.equal(
        await git(workspace.path, "show", `${commit}:draft.txt`),
        draft,
      );
      rows.push({
        operation: `${name} snapshot`,
        elapsedMs: Math.round(performance.now() - started),
        ...timing,
      });
    }
    const started = performance.now();
    const archived = await archiveWorkspace({
      workspaceId: workspace.workspaceId,
      stashUncommitted: true,
    });
    rows.push({
      operation: "archive",
      elapsedMs: Math.round(performance.now() - started),
    });
    assert(archived.archiveSnapshot);
    const restored = await restoreWorkspace(workspace.workspaceId);
    assert.equal(
      await readFile(path.join(restored.path, "draft.txt"), "utf8"),
      draft,
    );
    assert.deepEqual(
      await readFile(path.join(restored.path, "fixture/0.bin")),
      block,
    );
    console.log(
      `Archive benchmark: ${process.platform}/${process.arch}; 512 tracked files, 128 MiB; warm OS filesystem cache.`,
    );
    console.table(rows);
    console.log(
      "Archive/restore verified the uncommitted draft and a binary fixture.",
    );
  } finally {
    closeState();
    setStateRootForTesting(null);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
