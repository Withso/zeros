import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  closeState,
  createWorkspace,
  getWorkspace,
  inspectApplyPatchPaths,
  setStateRootForTesting,
  stagePaths,
  status,
  unstagePaths,
} from "..";

const execFileAsync = promisify(execFile);

describe("stage / unstage", () => {
  let workdir: string;
  let repoRoot: string;
  let stateRoot: string;
  let workspaceId: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-stage-test-"));
    repoRoot = path.join(workdir, "repo");
    stateRoot = path.join(workdir, "state");
    setStateRootForTesting(stateRoot);
    await mkdir(repoRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
    await execFileAsync("git", ["remote", "add", "origin", "https://example.com/s/t.git"], {
      cwd: repoRoot,
    });
    await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, "a.txt"), "a\n");
    await execFileAsync("git", ["add", "."], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
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

  it("stages multiple files in one call", async () => {
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, "b.txt"), "b\n");
    await writeFile(path.join(ws.path, "c.txt"), "c\n");
    await stagePaths({
      workspaceId,
      paths: ["b.txt", "c.txt"],
    });
    const s = await status(workspaceId);
    expect(s.staged.map((f) => f.path).sort()).toEqual(["b.txt", "c.txt"]);
    expect(s.untracked).toEqual([]);
  });

  it("unstage returns paths to untracked / unstaged", async () => {
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, "b.txt"), "b\n");
    await stagePaths({ workspaceId, paths: ["b.txt"] });
    await unstagePaths({ workspaceId, paths: ["b.txt"] });
    const s = await status(workspaceId);
    expect(s.untracked).toContain("b.txt");
    expect(s.staged).toEqual([]);
  });

  it("rejects empty paths array", async () => {
    await expect(
      stagePaths({ workspaceId, paths: [] }),
    ).rejects.toThrow();
  });

  it("rejects paths that look like flags", async () => {
    await expect(
      stagePaths({ workspaceId, paths: ["--all"] }),
    ).rejects.toThrow();
  });

  it("inspects both paths in a NUL-delimited rename patch", async () => {
    const ws = getWorkspace(workspaceId);
    await execFileAsync("git", ["mv", "a.txt", "renamed.txt"], {
      cwd: ws.path,
    });
    const { stdout: patch } = await execFileAsync(
      "git",
      ["diff", "--cached", "--binary", "-M"],
      { cwd: ws.path },
    );

    await expect(
      inspectApplyPatchPaths({ workspaceId, patch }),
    ).resolves.toEqual(expect.arrayContaining(["a.txt", "renamed.txt"]));
  });
});
