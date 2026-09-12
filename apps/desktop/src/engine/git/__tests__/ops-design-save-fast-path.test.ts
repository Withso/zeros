import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../design/directory", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../design/directory")>();
  return {
    ...actual,
    discoverDesignDirectories: vi.fn(async () => {
      throw new Error("unrelated Design discovery must not run");
    }),
  };
});

import {
  closeState,
  commit,
  createWorkspace,
  getWorkspace,
  setStateRootForTesting,
} from "..";
import { designDirectoryNameFor } from "../../design/directory-registry";

const execFileAsync = promisify(execFile);

describe("explicit Design commit fast path", () => {
  let root: string;
  let repoRoot: string;
  let stateRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-save-test-"));
    repoRoot = path.join(root, "repo");
    stateRoot = path.join(root, "state");
    setStateRootForTesting(stateRoot);
    await mkdir(repoRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], {
      cwd: repoRoot,
    });
    await execFileAsync("git", [
      "init",
      "-q",
      "--bare",
      path.join(root, "remote.git"),
    ]);
    await execFileAsync(
      "git",
      ["remote", "add", "origin", path.join(root, "remote.git")],
      { cwd: repoRoot },
    );
    await execFileAsync("git", ["config", "user.email", "t@t"], {
      cwd: repoRoot,
    });
    await execFileAsync("git", ["config", "user.name", "t"], {
      cwd: repoRoot,
    });
    await writeFile(path.join(repoRoot, "README.md"), "base\n");
    await execFileAsync("git", ["add", "."], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "base"], {
      cwd: repoRoot,
    });
    await execFileAsync("git", ["push", "-q", "-u", "origin", "main"], {
      cwd: repoRoot,
    });
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    await rm(root, { recursive: true, force: true });
  });

  it("commits only an already-staged active Design index without repository-wide discovery", async () => {
    const created = await createWorkspace({ repoRoot });
    const workspace = getWorkspace(created.workspaceId);
    const designName = designDirectoryNameFor(workspace.path);
    const design = path.join(workspace.path, designName);
    await mkdir(design, { recursive: true });
    await Promise.all([
      writeFile(path.join(design, ".zeros-canvas.json"), "{}\n"),
      writeFile(path.join(design, "frame.html"), "<main>frame</main>\n"),
    ]);
    await execFileAsync("git", ["add", "--", designName], {
      cwd: workspace.path,
    });

    await expect(
      commit({
        workspaceId: created.workspaceId,
        message: "Commit designs",
        authority: "design",
      }),
    ).resolves.toMatchObject({ sha: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });
});
