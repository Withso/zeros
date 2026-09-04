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
  merge,
  pull,
  push,
  rebase,
  setStateRootForTesting,
  stagePaths,
  stashPop,
  stashSave,
} from "..";
import { designDirectoryNameFor } from "../../design/directory-registry";

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
    const designName = designDirectoryNameFor(ws.path);
    const designDir = path.join(ws.path, designName);
    await mkdir(designDir, { recursive: true });
    await writeFile(path.join(designDir, "rogue.html"), "<main>rogue</main>\n");
    // Simulate a shell/agent bypass of the service's git.stage guard. The
    // commit primitive itself is the final backstop.
    await execFileAsync("git", ["-C", ws.path, "add", "--", designName]);
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
      remediation: expect.stringMatching(/stage and commit/i),
    });
    const after = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(after).toBe(before);
  });

  it("commits only the staged Code lane while leaving staged Design changes intact", async () => {
    const ws = getWorkspace(workspaceId);
    const designName = designDirectoryNameFor(ws.path);
    const designDir = path.join(ws.path, designName);
    await mkdir(designDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(ws.path, "code.txt"), "code\n"),
      writeFile(path.join(designDir, ".zeros-canvas.json"), "{}\n"),
      writeFile(path.join(designDir, "frame.html"), "<main>draft</main>\n"),
    ]);
    await execFileAsync("git", ["add", "--", "code.txt", designName], {
      cwd: ws.path,
    });

    await expect(
      commit({ workspaceId, message: "Commit Code lane", authority: "code" }),
    ).resolves.toMatchObject({ sha: expect.any(String) });
    const committed = (
      await execFileAsync(
        "git",
        ["show", "--pretty=format:", "--name-only", "HEAD"],
        { cwd: ws.path },
      )
    ).stdout;
    const stillStaged = (
      await execFileAsync("git", ["diff", "--cached", "--name-only"], {
        cwd: ws.path,
      })
    ).stdout;
    expect(committed).toContain("code.txt");
    expect(committed).not.toContain(`${designName}/`);
    expect(stillStaged).toContain(`${designName}/frame.html`);
    expect(stillStaged).not.toContain("code.txt");
  });

  it("commits only the staged Design lane while leaving staged Code changes intact", async () => {
    const ws = getWorkspace(workspaceId);
    const designName = designDirectoryNameFor(ws.path);
    const designDir = path.join(ws.path, designName);
    await mkdir(designDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(ws.path, "code.txt"), "code\n"),
      writeFile(path.join(designDir, ".zeros-canvas.json"), "{}\n"),
      writeFile(path.join(designDir, "frame.html"), "<main>draft</main>\n"),
    ]);
    await execFileAsync("git", ["add", "--", "code.txt", designName], {
      cwd: ws.path,
    });

    await expect(
      commit({
        workspaceId,
        message: "Commit Design lane",
        authority: "design",
      }),
    ).resolves.toMatchObject({ sha: expect.any(String) });
    const committed = (
      await execFileAsync(
        "git",
        ["show", "--pretty=format:", "--name-only", "HEAD"],
        { cwd: ws.path },
      )
    ).stdout;
    const stillStaged = (
      await execFileAsync("git", ["diff", "--cached", "--name-only"], {
        cwd: ws.path,
      })
    ).stdout;
    expect(committed).toContain(`${designName}/frame.html`);
    expect(committed).not.toContain("code.txt");
    expect(stillStaged).toContain("code.txt");
    expect(stillStaged).not.toContain(`${designName}/`);
  });

  it("refuses to amend a Design checkpoint through Code authority", async () => {
    const ws = getWorkspace(workspaceId);
    const designName = designDirectoryNameFor(ws.path);
    const designDir = path.join(ws.path, designName);
    await mkdir(designDir, { recursive: true });
    await writeFile(
      path.join(designDir, "frame.html"),
      "<main>checkpoint</main>\n",
    );
    await execFileAsync("git", ["add", "--", designName], {
      cwd: ws.path,
    });
    await execFileAsync("git", ["commit", "-q", "-m", "Design checkpoint"], {
      cwd: ws.path,
    });
    await writeFile(path.join(ws.path, "code.txt"), "code\n");
    await execFileAsync("git", ["add", "--", "code.txt"], { cwd: ws.path });

    await expect(
      commit({
        workspaceId,
        message: "Do not fold Code into Design",
        amend: true,
        authority: "code",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/Design checkpoint/i),
    });
  });

  it("preserves the original author identity when Code authority amends", async () => {
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, "authored.txt"), "first\n");
    await execFileAsync("git", ["-C", ws.path, "add", "authored.txt"]);
    await execFileAsync(
      "git",
      ["-C", ws.path, "commit", "-q", "-m", "authored"],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Original Author",
          GIT_AUTHOR_EMAIL: "original@example.test",
        },
      },
    );
    await writeFile(path.join(ws.path, "authored.txt"), "amended\n");
    await execFileAsync("git", ["-C", ws.path, "add", "authored.txt"]);

    await commit({
      workspaceId,
      message: "amended",
      amend: true,
      authority: "code",
    });

    const author = (
      await execFileAsync("git", [
        "-C",
        ws.path,
        "show",
        "-s",
        "--format=%an <%ae>",
        "HEAD",
      ])
    ).stdout.trim();
    expect(author).toBe("Original Author <original@example.test>");
  });

  it("refuses a normal commit while an explicit Git continuation is required", async () => {
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, "code.txt"), "code\n");
    await execFileAsync("git", ["add", "--", "code.txt"], { cwd: ws.path });
    const head = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ws.path })
    ).stdout.trim();
    const mergeHead = (
      await execFileAsync("git", ["rev-parse", "--git-path", "MERGE_HEAD"], {
        cwd: ws.path,
      })
    ).stdout.trim();
    await writeFile(path.resolve(ws.path, mergeHead), `${head}\n`);

    await expect(
      commit({
        workspaceId,
        message: "bypass continuation",
        authority: "code",
      }),
    ).rejects.toMatchObject({ code: "MERGE_IN_PROGRESS" });
  });

  it("defaults internal commit callers to code authority instead of bypassing Design protection", async () => {
    const ws = getWorkspace(workspaceId);
    const designName = designDirectoryNameFor(ws.path);
    const designDir = path.join(ws.path, designName);
    await mkdir(designDir, { recursive: true });
    await writeFile(path.join(designDir, "rogue.html"), "<main>rogue</main>\n");
    await execFileAsync("git", ["-C", ws.path, "add", "--", designName]);
    const before = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"])
    ).stdout.trim();

    await expect(
      commit({
        workspaceId,
        message: "implicit authority bypass",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      remediation: expect.stringMatching(/stage and commit/i),
    });
    const after = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(after).toBe(before);
  });

  it("treats an empty code pathspec as an ordinary commit and still blocks staged Design paths", async () => {
    const ws = getWorkspace(workspaceId);
    const designName = designDirectoryNameFor(ws.path);
    const designDir = path.join(ws.path, designName);
    await mkdir(designDir, { recursive: true });
    await writeFile(path.join(designDir, "rogue.html"), "<main>rogue</main>\n");
    await execFileAsync("git", ["-C", ws.path, "add", "--", designName]);

    await expect(
      commit({
        workspaceId,
        message: "empty pathspec bypass",
        files: [],
        authority: "code",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      remediation: expect.stringMatching(/stage and commit/i),
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
    await writeFile(
      path.join(nestedDesign, "frame.html"),
      "<main>frame</main>\n",
    );
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
      remediation: expect.stringMatching(/stage and commit/i),
    });
    const after = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(after).toBe(before);
  });

  it("blocks the Design source of a staged rename out of the active directory", async () => {
    const ws = getWorkspace(workspaceId);
    const designName = designDirectoryNameFor(ws.path);
    const designDir = path.join(ws.path, designName);
    await mkdir(designDir, { recursive: true });
    await writeFile(path.join(designDir, "frame.html"), "<main>frame</main>\n");
    await execFileAsync("git", ["-C", ws.path, "add", "--", designName]);
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
      `${designName}/frame.html`,
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
      remediation: expect.stringMatching(/stage and commit/i),
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
      remediation: expect.stringMatching(/stage and commit/i),
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

  it("pushes the branch actually checked out by an unrestricted native Git command", async () => {
    const ws = getWorkspace(workspaceId);
    await execFileAsync("git", ["checkout", "-q", "-b", "manual-current"], {
      cwd: ws.path,
    });
    await writeFile(path.join(ws.path, "manual.txt"), "manual\n");
    await execFileAsync("git", ["add", "--", "manual.txt"], { cwd: ws.path });
    await execFileAsync("git", ["commit", "-q", "-m", "manual branch"], {
      cwd: ws.path,
    });

    await expect(push({ workspaceId })).resolves.toMatchObject({
      remoteRef: "origin/manual-current",
    });
    const remoteBranch = (
      await execFileAsync(
        "git",
        ["--git-dir", bareRemote, "rev-parse", "refs/heads/manual-current"],
        { cwd: workdir },
      )
    ).stdout.trim();
    const localHead = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ws.path })
    ).stdout.trim();
    expect(remoteBranch).toBe(localHead);
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

  it("pulls code-only commits while an untracked Design draft stays live", async () => {
    const ws = getWorkspace(workspaceId);
    await push({ workspaceId });
    await mkdir(path.join(ws.path, "Zeros Design"), { recursive: true });
    const draft = path.join(ws.path, "Zeros Design", "draft.html");
    await writeFile(draft, "<main>local draft</main>\n");

    const teammate = path.join(workdir, "teammate-code-only");
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
    await writeFile(path.join(teammate, "code-only.txt"), "code\n");
    await execFileAsync("git", ["-C", teammate, "add", "code-only.txt"]);
    await execFileAsync("git", [
      "-C",
      teammate,
      "commit",
      "-q",
      "-m",
      "code only",
    ]);
    await execFileAsync("git", ["-C", teammate, "push", "-q"]);

    await expect(
      pull({ workspaceId, strategy: "rebase" }),
    ).resolves.toMatchObject({ conflicts: [] });
    await expect(readFile(draft, "utf8")).resolves.toBe(
      "<main>local draft</main>\n",
    );
    await expect(
      readFile(path.join(ws.path, "code-only.txt"), "utf8"),
    ).resolves.toBe("code\n");
  });

  it("refuses an incoming Design commit before it can overwrite an untracked draft", async () => {
    const ws = getWorkspace(workspaceId);
    await push({ workspaceId });
    await mkdir(path.join(ws.path, "Zeros Design"), { recursive: true });
    const draft = path.join(ws.path, "Zeros Design", "draft.html");
    await writeFile(draft, "<main>local draft</main>\n");
    const headBefore = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"])
    ).stdout.trim();

    const teammate = path.join(workdir, "teammate-design-untracked");
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
    await mkdir(path.join(teammate, "Zeros Design"), { recursive: true });
    await writeFile(
      path.join(teammate, "Zeros Design", ".zeros-canvas.json"),
      "{}\n",
    );
    await writeFile(
      path.join(teammate, "Zeros Design", "draft.html"),
      "<main>remote design</main>\n",
    );
    await execFileAsync("git", ["-C", teammate, "add", "Zeros Design"]);
    await execFileAsync("git", [
      "-C",
      teammate,
      "commit",
      "-q",
      "-m",
      "design",
    ]);
    await execFileAsync("git", ["-C", teammate, "push", "-q"]);

    await expect(
      pull({ workspaceId, strategy: "rebase" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      remediation: expect.stringMatching(/commit.*Design|Design.*commit/i),
    });
    await expect(readFile(draft, "utf8")).resolves.toBe(
      "<main>local draft</main>\n",
    );
    await expect(
      execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"]),
    ).resolves.toMatchObject({ stdout: `${headBefore}\n` });
  });

  it("refuses an incoming Design commit before Git can silently overwrite an ignored draft", async () => {
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, ".gitignore"), "Zeros Design/\n");
    await execFileAsync("git", ["-C", ws.path, "add", ".gitignore"]);
    await execFileAsync("git", [
      "-C",
      ws.path,
      "commit",
      "-q",
      "-m",
      "ignore draft",
    ]);
    await push({ workspaceId });
    await mkdir(path.join(ws.path, "Zeros Design"), { recursive: true });
    const draft = path.join(ws.path, "Zeros Design", "draft.html");
    await writeFile(draft, "<main>ignored local draft</main>\n");

    const teammate = path.join(workdir, "teammate-design-ignored");
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
    await mkdir(path.join(teammate, "Zeros Design"), { recursive: true });
    await writeFile(
      path.join(teammate, "Zeros Design", ".zeros-canvas.json"),
      "{}\n",
    );
    await writeFile(
      path.join(teammate, "Zeros Design", "draft.html"),
      "<main>remote design</main>\n",
    );
    await execFileAsync("git", ["-C", teammate, "add", "-f", "Zeros Design"]);
    await execFileAsync("git", [
      "-C",
      teammate,
      "commit",
      "-q",
      "-m",
      "design",
    ]);
    await execFileAsync("git", ["-C", teammate, "push", "-q"]);

    await expect(
      pull({ workspaceId, strategy: "merge" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(readFile(draft, "utf8")).resolves.toBe(
      "<main>ignored local draft</main>\n",
    );
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

  it("refuses rebase before it can overwrite an ignored live Design draft", async () => {
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, ".gitignore"), "Zeros Design/\n");
    await execFileAsync("git", ["add", ".gitignore"], { cwd: ws.path });
    await execFileAsync("git", ["commit", "-q", "-m", "ignore design"], {
      cwd: ws.path,
    });
    await mkdir(path.join(ws.path, "Zeros Design"), { recursive: true });
    const draft = path.join(ws.path, "Zeros Design", "draft.html");
    await writeFile(draft, "<main>local ignored draft</main>\n");

    await mkdir(path.join(repoRoot, "Zeros Design"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "Zeros Design", ".zeros-canvas.json"),
      "{}\n",
    );
    await writeFile(
      path.join(repoRoot, "Zeros Design", "draft.html"),
      "<main>target design</main>\n",
    );
    await execFileAsync("git", ["add", "Zeros Design"], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "target design"], {
      cwd: repoRoot,
    });

    await expect(
      rebase({ workspaceId, ontoBranch: "main" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(readFile(draft, "utf8")).resolves.toBe(
      "<main>local ignored draft</main>\n",
    );
  });

  it("refuses rebase before committed Design revisions can conflict", async () => {
    const ws = getWorkspace(workspaceId);
    await mkdir(path.join(repoRoot, "Zeros Design"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(repoRoot, "Zeros Design", ".zeros-canvas.json"),
        "{}\n",
      ),
      writeFile(
        path.join(repoRoot, "Zeros Design", "draft.html"),
        "<main>base</main>\n",
      ),
    ]);
    await execFileAsync("git", ["add", "Zeros Design"], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "design base"], {
      cwd: repoRoot,
    });
    await merge({ workspaceId, branch: "main" });

    await writeFile(
      path.join(repoRoot, "Zeros Design", "draft.html"),
      "<main>target</main>\n",
    );
    await execFileAsync("git", ["commit", "-aqm", "target design"], {
      cwd: repoRoot,
    });
    const draft = path.join(ws.path, "Zeros Design", "draft.html");
    await writeFile(draft, "<main>local</main>\n");
    await execFileAsync("git", ["commit", "-aqm", "local design"], {
      cwd: ws.path,
    });

    await expect(
      rebase({ workspaceId, ontoBranch: "main" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/Design.*conflict/i),
    });
    await expect(readFile(draft, "utf8")).resolves.toBe("<main>local</main>\n");
  });

  it("refuses Git autostash while a live Design draft is dirty", async () => {
    const ws = getWorkspace(workspaceId);
    await mkdir(path.join(repoRoot, "Zeros Design"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(repoRoot, "Zeros Design", ".zeros-canvas.json"),
        "{}\n",
      ),
      writeFile(
        path.join(repoRoot, "Zeros Design", "draft.html"),
        "<main>baseline</main>\n",
      ),
    ]);
    await execFileAsync("git", ["add", "Zeros Design"], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "design baseline"], {
      cwd: repoRoot,
    });
    await merge({ workspaceId, branch: "main" });

    const draft = path.join(ws.path, "Zeros Design", "draft.html");
    await writeFile(draft, "<main>live draft</main>\n");
    await writeFile(path.join(repoRoot, "code-after-design.txt"), "code\n");
    await execFileAsync("git", ["add", "code-after-design.txt"], {
      cwd: repoRoot,
    });
    await execFileAsync("git", ["commit", "-q", "-m", "code update"], {
      cwd: repoRoot,
    });

    await expect(
      rebase({ workspaceId, ontoBranch: "main", autoStash: true }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(readFile(draft, "utf8")).resolves.toBe(
      "<main>live draft</main>\n",
    );
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

  it("stashes only Code work and leaves the live Design draft in place", async () => {
    const ws = getWorkspace(workspaceId);
    const designDir = path.join(ws.path, designDirectoryNameFor(ws.path));
    await mkdir(designDir, { recursive: true });
    const designDraft = path.join(designDir, "draft.html");
    await writeFile(designDraft, "<main>live design</main>\n");
    await writeFile(path.join(ws.path, "README.md"), "# code work\n");

    const save = await stashSave({ workspaceId, message: "code only" });
    await expect(readFile(designDraft, "utf8")).resolves.toBe(
      "<main>live design</main>\n",
    );
    await expect(
      readFile(path.join(ws.path, "README.md"), "utf8"),
    ).resolves.toBe("# initial\n");

    await stashPop({ workspaceId, stashRef: save.stashRef });
    await expect(
      readFile(path.join(ws.path, "README.md"), "utf8"),
    ).resolves.toBe("# code work\n");
    await expect(readFile(designDraft, "utf8")).resolves.toBe(
      "<main>live design</main>\n",
    );
  });

  it("does not return an older stash when only Design work is present", async () => {
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, "README.md"), "# first code stash\n");
    const existing = await stashSave({ workspaceId, message: "existing" });
    const designDir = path.join(ws.path, designDirectoryNameFor(ws.path));
    await mkdir(designDir, { recursive: true });
    await writeFile(
      path.join(designDir, "draft.html"),
      "<main>only design</main>\n",
    );

    await expect(
      stashSave({ workspaceId, message: "design only" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const latest = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "stash@{0}"])
    ).stdout.trim();
    expect(latest).toBe(existing.stashRef);
  });
});
