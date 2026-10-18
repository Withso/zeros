import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "../types";

const fixture = vi.hoisted(() => ({ workspaces: new Map<string, Workspace>() }));
vi.mock("../worktree", () => ({ resolveRepoForGitOp: async (id: string) => fixture.workspaces.get(id)! }));
vi.mock("../../settings/repo-git", () => ({ resolveRepoGit: () => ({ remote: "origin" }) }));

import { changeLineCounts, status } from "../diff";
import { engineGitBinary } from "../git-exec";
import { invalidateWorkspaceChangeProbes } from "../workspace-change-probe";

const exec = promisify(execFile);
let directory: string;
let realGit: string;
let spawnLog: string;

async function createFixture(id: string): Promise<Workspace> {
  const root = path.join(directory, id);
  await mkdir(root);
  const git = (args: string[]) => exec(realGit, args, { cwd: root });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "fixture@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "tracked.txt"), "initial\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "initial"]);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(["checkout", "-qb", "feature"]);
  await writeFile(path.join(root, "tracked.txt"), "working\n");
  const workspace: Workspace = {
    id, repoRoot: root, repoSlug: id, path: root, branch: "feature", baseBranch: "main", createdAt: 1,
    archivedAt: null, stashRef: null, status: "in-progress", prNumber: null, prState: null,
    prUrl: null, agentId: null, lastActiveAt: null, placement: "local", organizationId: null,
  };
  fixture.workspaces.set(id, workspace);
  return workspace;
}

/** Slow chosen Git reads through a PATH wrapper, logging every launch. */
async function slowGit(slowWhen: string) {
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "git"),
    `#!/bin/sh\nprintf "%s %s\\n" "$PWD" "$*" >> "$ZEROS_TEST_GIT_SPAWNS"\n${slowWhen}\nexec "$ZEROS_TEST_GIT_BINARY" "$@"\n`,
    { mode: 0o700 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "zeros-change-freshness-"));
  realGit = engineGitBinary();
  spawnLog = path.join(directory, "git-spawns");
  await writeFile(spawnLog, "");
  vi.stubEnv("ZEROS_TEST_GIT_BINARY", realGit);
  vi.stubEnv("ZEROS_TEST_GIT_SPAWNS", spawnLog);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  fixture.workspaces.clear();
  await rm(directory, { recursive: true, force: true });
});

describe("Local change reads stay fresh and foreground", () => {
  it("answers a status for an invalidated workspace before other workspaces' slow background reads", async () => {
    await slowGit('case "$PWD" in *slow-*) sleep 1;; esac');
    const slow = await Promise.all([0, 1, 2, 3].map((index) => createFixture(`slow-${index}`)));
    const target = await createFixture("target");
    let backgroundSettled = 0;
    const background = [...slow, target].map((workspace) =>
      changeLineCounts(workspace.id).finally(() => { backgroundSettled += 1; }));
    for (;;) {
      if ((await readFile(spawnLog, "utf8")).includes("slow-3")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // A watcher event for the target workspace (an edit was observed).
    invalidateWorkspaceChangeProbes([target.id]);
    await status(target.id);
    expect(backgroundSettled).toBe(0);
    await Promise.all(background);
  }, 60_000);

  it("reports no upstream once the tracked remote branch is gone", async () => {
    const workspace = await createFixture("pruned");
    const git = (args: string[]) => exec(realGit, args, { cwd: workspace.path });
    await git(["remote", "add", "origin", "https://example.invalid/repository.git"]);
    await git(["update-ref", "refs/remotes/origin/feature", "HEAD"]);
    await git(["branch", "--set-upstream-to=origin/feature"]);
    expect(await status(workspace.id)).toMatchObject({ upstream: "origin/feature", ahead: 0, behind: 0 });
    // The PR merged with branch deletion, then `fetch --prune` removed the ref.
    await git(["update-ref", "-d", "refs/remotes/origin/feature"]);
    expect(await status(workspace.id)).toMatchObject({ upstream: null, ahead: null, behind: null });
  });

  it("lists an untracked file created after another reader's status settled", async () => {
    await slowGit('case "$*" in *--numstat*) sleep 1;; esac');
    const workspace = await createFixture("workspace");
    const background = changeLineCounts(workspace.id);
    // Wait until that reader is in its slow line-count phase (status settled).
    for (;;) {
      if ((await readFile(spawnLog, "utf8")).includes("--numstat")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // A Design frame written by an agent just before Reset/Clean checks.
    await mkdir(path.join(workspace.path, "Design"), { recursive: true });
    await writeFile(path.join(workspace.path, "Design", "frame.html"), "<div></div>\n");
    const observed = await status(workspace.id);
    await background;
    expect(observed.untracked).toContain("Design/frame.html");
  }, 60_000);
});
