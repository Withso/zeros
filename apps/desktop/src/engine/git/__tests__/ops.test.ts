// Git write-operation acceptance coverage.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  changeTargetBranch,
  closeState,
  commit,
  createWorkspace,
  getWorkspace,
  pull,
  push,
  rebase,
  setStateRootForTesting,
  stagePaths,
  stashPop,
  stashSave,
} from "..";

const execFileAsync = promisify(execFile);

async function initRepoWithRemote(opts: {
  repoRoot: string;
  bareRemotePath: string;
}): Promise<void> {
  await mkdir(opts.repoRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main"], {
    cwd: opts.repoRoot,
  });
  await execFileAsync("git", ["init", "-q", "--bare", opts.bareRemotePath]);
  await execFileAsync("git", ["remote", "add", "origin", opts.bareRemotePath], {
    cwd: opts.repoRoot,
  });
  await execFileAsync("git", ["config", "user.email", "t@t"], {
    cwd: opts.repoRoot,
  });
  await execFileAsync("git", ["config", "user.name", "t"], {
    cwd: opts.repoRoot,
  });
  await writeFile(path.join(opts.repoRoot, "README.md"), "# initial\n");
  await execFileAsync("git", ["add", "."], { cwd: opts.repoRoot });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
    cwd: opts.repoRoot,
  });
  // Push main so the remote has it as default. Workspaces will fork off this.
  await execFileAsync("git", ["push", "-q", "-u", "origin", "main"], {
    cwd: opts.repoRoot,
  });
}

describe("write ops", () => {
  let workdir: string;
  let repoRoot: string;
  let bareRemote: string;
  let stateRoot: string;
  let workspaceId: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-ops-test-"));
    repoRoot = path.join(workdir, "repo");
    bareRemote = path.join(workdir, "remote.git");
    stateRoot = path.join(workdir, "state");
    setStateRootForTesting(stateRoot);
    await initRepoWithRemote({ repoRoot, bareRemotePath: bareRemote });
    const created = await createWorkspace({ repoRoot });
    workspaceId = created.workspaceId;
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("commits staged changes (status stays in-progress — no draft→active step in v18)", async () => {
    const ws = getWorkspace(workspaceId);
    expect(ws.status).toBe("in-progress");
    await writeFile(path.join(ws.path, "new.txt"), "hello\n");
    await stagePaths({ workspaceId, paths: ["new.txt"] });
    const c = await commit({ workspaceId, message: "add new.txt" });
    expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(c.branch).toBe(ws.branch);
    const refreshed = getWorkspace(workspaceId);
    expect(refreshed.status).toBe("in-progress");
    expect(refreshed.lastActiveAt).not.toBeNull();
  });

  it("keeps exact filenames containing Git pathspec metacharacters usable", async () => {
    const ws = getWorkspace(workspaceId);
    const filename = "notes[1].txt";
    await writeFile(path.join(ws.path, filename), "literal path\n");
    await stagePaths({ workspaceId, paths: [filename] });

    await expect(
      commit({
        workspaceId,
        message: "literal metacharacter path",
        files: [filename],
        authority: "code",
      }),
    ).resolves.toMatchObject({ sha: expect.any(String) });
    await expect(readFile(path.join(ws.path, filename), "utf8")).resolves.toBe(
      "literal path\n",
    );
  });

  it("commit fails when nothing staged", async () => {
    await expect(commit({ workspaceId, message: "empty" })).rejects.toThrow(
      /Nothing to commit|VALIDATION_FAILED/,
    );
  });

  it("refuses a direct code commit when a Design path was staged outside the service", async () => {
    const ws = getWorkspace(workspaceId);
    const designDir = path.join(ws.path, "Zeros Design");
    await mkdir(designDir, { recursive: true });
    await writeFile(path.join(designDir, "rogue.html"), "<main>rogue</main>\n");
    // Simulate a shell/agent bypass of the service's git.stage guard. The
    // commit primitive itself is the final backstop.
    await execFileAsync("git", ["-C", ws.path, "add", "--", "Zeros Design"]);
    const before = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"])
    ).stdout.trim();

    await expect(
      commit({
        workspaceId,
        message: "bypass design guard",
        authority: "code",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      remediation: expect.stringMatching(/Save designs/),
    });
    const after = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(after).toBe(before);
  });

  it("treats an empty code pathspec as an ordinary commit and still blocks staged Design paths", async () => {
    const ws = getWorkspace(workspaceId);
    const designDir = path.join(ws.path, "Zeros Design");
    await mkdir(designDir, { recursive: true });
    await writeFile(path.join(designDir, "rogue.html"), "<main>rogue</main>\n");
    await execFileAsync("git", ["-C", ws.path, "add", "--", "Zeros Design"]);

    await expect(
      commit({
        workspaceId,
        message: "empty pathspec bypass",
        files: [],
        authority: "code",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      remediation: expect.stringMatching(/Save designs/),
    });
  });

  it("does not expand a Git-magic-looking direct commit filename", async () => {
    const ws = getWorkspace(workspaceId);
    const designDir = path.join(ws.path, "Zeros Design");
    await mkdir(designDir, { recursive: true });
    await writeFile(path.join(designDir, "rogue.html"), "<main>rogue</main>\n");
    await execFileAsync("git", ["-C", ws.path, "add", "--", "Zeros Design"]);
    const before = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"])
    ).stdout.trim();

    await expect(
      commit({
        workspaceId,
        message: "magic pathspec bypass",
        files: [":(top)Zeros Design/rogue.html"],
        authority: "code",
      }),
    ).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });
    const after = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(after).toBe(before);
  });

  it("blocks a direct code commit scoped to an ancestor of nested Design", async () => {
    const ws = getWorkspace(workspaceId);
    const nestedDesign = path.join(ws.path, "apps", "web", "canvas");
    await mkdir(nestedDesign, { recursive: true });
    await writeFile(path.join(nestedDesign, ".zeros-canvas.json"), "{}\n");
    await writeFile(path.join(nestedDesign, "frame.html"), "<main>frame</main>\n");
    await execFileAsync("git", ["-C", ws.path, "add", "--", "apps"]);
    const before = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"])
    ).stdout.trim();

    await expect(
      commit({
        workspaceId,
        message: "ancestor path bypass",
        files: ["apps"],
        authority: "code",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      remediation: expect.stringMatching(/Save designs/),
    });
    const after = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(after).toBe(before);
  });

  it("blocks the Design source of a staged rename out of the active directory", async () => {
    const ws = getWorkspace(workspaceId);
    const designDir = path.join(ws.path, "Zeros Design");
    await mkdir(designDir, { recursive: true });
    await writeFile(path.join(designDir, "frame.html"), "<main>frame</main>\n");
    await execFileAsync("git", ["-C", ws.path, "add", "--", "Zeros Design"]);
    await execFileAsync("git", [
      "-C",
      ws.path,
      "commit",
      "-q",
      "-m",
      "seed design",
    ]);
    await execFileAsync("git", [
      "-C",
      ws.path,
      "mv",
      "Zeros Design/frame.html",
      "escaped-frame.html",
    ]);

    await expect(
      commit({
        workspaceId,
        message: "rename out of design",
        authority: "code",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      remediation: expect.stringMatching(/Save designs/),
    });
  });

  it("blocks staged content from every recognized Design directory, not only the active one", async () => {
    const ws = getWorkspace(workspaceId);
    const secondary = path.join(ws.path, "Secondary Design");
    await mkdir(secondary, { recursive: true });
    await writeFile(path.join(secondary, ".zeros-canvas.json"), "{}\n");
    await writeFile(
      path.join(secondary, "frame.html"),
      "<main>secondary</main>\n",
    );
    await execFileAsync("git", [
      "-C",
      ws.path,
      "add",
      "--",
      "Secondary Design",
    ]);

    await expect(
      commit({
        workspaceId,
        message: "bypass inactive design guard",
        authority: "code",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      remediation: expect.stringMatching(/Save designs/),
    });
  });

  it("push to new remote sets upstream and reports remoteRef", async () => {
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, "a.txt"), "a\n");
    await stagePaths({ workspaceId, paths: ["a.txt"] });
    await commit({ workspaceId, message: "add a" });
    const result = await push({ workspaceId });
    expect(result.remoteRef).toBe(`origin/${ws.branch}`);
    // Upstream tracking — verify via git config.
    const { stdout } = await execFileAsync("git", [
      "-C",
      ws.path,
      "config",
      "--get",
      `branch.${ws.branch}.remote`,
    ]);
    expect(stdout.trim()).toBe("origin");
  });

  it("pull --rebase when behind main with no conflicts → fast-forwards", async () => {
    const ws = getWorkspace(workspaceId);
    // Make a commit and push it from another clone, simulating a
    // teammate pushing to the workspace's branch upstream.
    await writeFile(path.join(ws.path, "a.txt"), "a\n");
    await stagePaths({ workspaceId, paths: ["a.txt"] });
    await commit({ workspaceId, message: "add a" });
    await push({ workspaceId });

    // Simulate a teammate push by cloning the bare remote elsewhere,
    // adding a commit, and pushing.
    const teammate = path.join(workdir, "teammate");
    await execFileAsync("git", ["clone", "-q", bareRemote, teammate]);
    await execFileAsync("git", [
      "-C",
      teammate,
      "config",
      "user.email",
      "t2@t",
    ]);
    await execFileAsync("git", ["-C", teammate, "config", "user.name", "t2"]);
    await execFileAsync("git", ["-C", teammate, "checkout", "-q", ws.branch]);
    await writeFile(path.join(teammate, "b.txt"), "b\n");
    await execFileAsync("git", ["-C", teammate, "add", "."]);
    await execFileAsync("git", [
      "-C",
      teammate,
      "commit",
      "-q",
      "-m",
      "teammate",
    ]);
    await execFileAsync("git", ["-C", teammate, "push", "-q"]);

    // Fetch + pull --rebase in our workspace.
    await execFileAsync("git", ["-C", ws.path, "fetch", "-q"]);
    const result = await pull({ workspaceId, strategy: "rebase" });
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toBeGreaterThanOrEqual(1);
    // b.txt should exist locally now.
    const b = await readFile(path.join(ws.path, "b.txt"), "utf8");
    expect(b).toBe("b\n");
  });

  it("rebase onto main with uncommitted changes + autoStash=true succeeds", async () => {
    const ws = getWorkspace(workspaceId);
    // Add a commit to the root repo's main so the workspace branch
    // diverges.
    await writeFile(path.join(repoRoot, "main-new.txt"), "main\n");
    await execFileAsync("git", ["-C", repoRoot, "add", "."]);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "commit",
      "-q",
      "-m",
      "main update",
    ]);

    // Make a tracked-file modification in the workspace WITHOUT committing.
    await writeFile(path.join(ws.path, "README.md"), "# uncommitted\n");

    const result = await rebase({
      workspaceId,
      ontoBranch: "main",
      autoStash: true,
    });
    expect(result.conflicts).toEqual([]);
    // Uncommitted change should be restored after rebase.
    const readme = await readFile(path.join(ws.path, "README.md"), "utf8");
    expect(readme).toBe("# uncommitted\n");
    // The main update should now be in the worktree.
    const mainNew = await readFile(path.join(ws.path, "main-new.txt"), "utf8");
    expect(mainNew).toBe("main\n");
  });

  it("change target branch + rebase=true updates DB", async () => {
    // Create a second branch on the root repo.
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "checkout",
      "-q",
      "-b",
      "develop",
    ]);
    await writeFile(path.join(repoRoot, "dev.txt"), "dev\n");
    await execFileAsync("git", ["-C", repoRoot, "add", "."]);
    await execFileAsync("git", ["-C", repoRoot, "commit", "-q", "-m", "dev"]);
    await execFileAsync("git", ["-C", repoRoot, "checkout", "-q", "main"]);

    const result = await changeTargetBranch({
      workspaceId,
      newTarget: "develop",
      rebase: true,
    });
    expect(result.baseBranch).toBe("develop");
    expect(result.conflicts).toEqual([]);
    const refreshed = getWorkspace(workspaceId);
    expect(refreshed.baseBranch).toBe("develop");
  });

  it("changes target metadata without rebasing or disturbing an AD working tree", async () => {
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, "staged-new.txt"), "keep in index\n");
    await execFileAsync("git", ["add", "staged-new.txt"], { cwd: ws.path });
    await rm(path.join(ws.path, "staged-new.txt"));
    const before = (
      await execFileAsync("git", ["status", "--porcelain=v1"], {
        cwd: ws.path,
      })
    ).stdout;
    expect(before).toContain("AD staged-new.txt");

    const result = await changeTargetBranch({
      workspaceId,
      newTarget: "main",
    });

    expect(result).toEqual({ baseBranch: "main", conflicts: [] });
    expect(getWorkspace(workspaceId).baseBranch).toBe("main");
    const after = (
      await execFileAsync("git", ["status", "--porcelain=v1"], {
        cwd: ws.path,
      })
    ).stdout;
    expect(after).toBe(before);
  });

  it("stash save / pop round-trips", async () => {
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, "README.md"), "# saved\n");
    const save = await stashSave({
      workspaceId,
      message: "wip",
    });
    expect(save.stashRef).toMatch(/^[0-9a-f]{40}$/);
    // After save, the worktree should be clean.
    const readme = await readFile(path.join(ws.path, "README.md"), "utf8");
    expect(readme).toBe("# initial\n");

    const pop = await stashPop({ workspaceId, stashRef: save.stashRef });
    expect(pop.conflicts).toEqual([]);
    const restored = await readFile(path.join(ws.path, "README.md"), "utf8");
    expect(restored).toBe("# saved\n");
  });
});
