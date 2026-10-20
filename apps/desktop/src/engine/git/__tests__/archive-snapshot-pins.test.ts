// Startup maintenance of archive recovery pins. Long-lived installs keep a
// saved snapshot for every workspace ever archived, and this runs before the
// engine reports ready, so its cost must not grow one Git process per row.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const gitCalls = vi.hoisted(() => ({ argv: [] as string[][] }));
vi.mock("../git-exec", async (original) => {
  const actual = await original<typeof import("../git-exec")>();
  return {
    ...actual,
    runGit: (...call: Parameters<typeof actual.runGit>) => {
      gitCalls.argv.push([...call[1]]);
      return actual.runGit(...call);
    },
  };
});

import {
  archiveWorkspace,
  closeState,
  createWorkspace,
  setStateRootForTesting,
} from "..";
import { pruneOrphanArchiveSnapshots } from "../worktree";
import { archiveSnapshotRef } from "../turns-git";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync("git", args, { cwd })).stdout.trim();

describe("archive snapshot pins at startup", () => {
  let workdir: string;
  let repoRoot: string;

  beforeEach(async () => {
    workdir = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-archive-pins-")),
    );
    repoRoot = path.join(workdir, "repo");
    const remote = path.join(workdir, "remote");
    setStateRootForTesting(path.join(workdir, "state"));
    await mkdir(repoRoot, { recursive: true });
    await git(workdir, "init", "-q", "--bare", "-b", "main", remote);
    await git(repoRoot, "init", "-q", "-b", "main");
    await git(repoRoot, "remote", "add", "origin", remote);
    await git(repoRoot, "config", "user.email", "test@test");
    await git(repoRoot, "config", "user.name", "test");
    await writeFile(path.join(repoRoot, "README.md"), "# test\n");
    await git(repoRoot, "add", ".");
    await git(repoRoot, "commit", "-q", "-m", "init");
    await git(repoRoot, "push", "-q", "-u", "origin", "main");
    await git(repoRoot, "remote", "set-head", "origin", "main");
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  });

  async function archivedWorkspaces(count: number) {
    const archived: { workspaceId: string; snapshot: string }[] = [];
    for (let index = 0; index < count; index++) {
      const created = await createWorkspace({ repoRoot });
      await writeFile(path.join(created.path, "wip.txt"), `draft ${index}\n`);
      const result = await archiveWorkspace({
        workspaceId: created.workspaceId,
        stashUncommitted: true,
      });
      archived.push({
        workspaceId: created.workspaceId,
        snapshot: result.archiveSnapshot!,
      });
    }
    return archived;
  }

  it("checks existing pins with one ref listing per repository", async () => {
    const archived = await archivedWorkspaces(3);
    gitCalls.argv = [];

    await pruneOrphanArchiveSnapshots();

    expect(gitCalls.argv).toEqual([
      ["for-each-ref", "--format=%(refname)", "refs/zeros/archive/"],
    ]);
    for (const { workspaceId, snapshot } of archived) {
      expect(await git(repoRoot, "rev-parse", archiveSnapshotRef(workspaceId))).toBe(
        snapshot,
      );
    }
  });

  it("repins only the snapshots whose ref is missing", async () => {
    const [kept, lost] = await archivedWorkspaces(2);
    await git(repoRoot, "update-ref", "-d", archiveSnapshotRef(lost!.workspaceId));
    gitCalls.argv = [];

    await pruneOrphanArchiveSnapshots();

    expect(gitCalls.argv.filter(([command]) => command === "update-ref")).toEqual([
      ["update-ref", archiveSnapshotRef(lost!.workspaceId), lost!.snapshot, ""],
    ]);
    expect(await git(repoRoot, "rev-parse", archiveSnapshotRef(lost!.workspaceId))).toBe(
      lost!.snapshot,
    );
    expect(await git(repoRoot, "rev-parse", archiveSnapshotRef(kept!.workspaceId))).toBe(
      kept!.snapshot,
    );
  });
});
