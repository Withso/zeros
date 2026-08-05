// Repository lifecycle scripts (settings TOML scripts.setup / scripts.archive)
// run against a REAL worktree. Asserts the inline command from .zeros/settings.toml
// executes in the worktree on create, and the archive command runs before removal.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  archiveWorkspace,
  closeState,
  createWorkspace,
  getWorkspace,
  restoreWorkspace,
  setStateRootForTesting,
} from "..";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function initRepo(
  repoRoot: string,
  settingsToml?: string,
): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, "init", "-q", "-b", "main");
  await git(
    repoRoot,
    "remote",
    "add",
    "origin",
    "https://example.com/t/scripts.git",
  );
  await git(repoRoot, "config", "user.email", "t@t");
  await git(repoRoot, "config", "user.name", "t");
  await writeFile(path.join(repoRoot, "README.md"), "# scripts test\n");
  if (settingsToml) {
    await mkdir(path.join(repoRoot, ".zeros"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".zeros", "settings.toml"),
      settingsToml,
    );
  }
  await git(repoRoot, "add", ".");
  await git(repoRoot, "commit", "-q", "-m", "initial");
}

describe("repo lifecycle scripts", () => {
  let workdir: string;
  let repoRoot: string;
  let userDir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-scripts-"));
    repoRoot = path.join(workdir, "repo");
    userDir = path.join(workdir, "user-settings");
    await mkdir(userDir, { recursive: true });
    process.env.ZEROS_USER_SETTINGS_DIR = userDir;
    setStateRootForTesting(path.join(workdir, "state"));
  });

  afterEach(async () => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    closeState();
    setStateRootForTesting(null);
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("resolves scripts.setup for a background run on create (not synchronous)", async () => {
    await initRepo(repoRoot, `[scripts]\nsetup = "touch setup-ran.txt"\n`);
    const created = await createWorkspace({ repoRoot });
    const wsPath = getWorkspace(created.workspaceId).path;
    // Setup now runs in the BACKGROUND (a PTY spawned by the engine), NOT
    // synchronously inside createWorkspace — so the marker is NOT created here.
    expect(existsSync(path.join(wsPath, "setup-ran.txt"))).toBe(false);
    // Instead, create returns the resolved command + marks the row "running".
    expect(created.setupCommand).toBe("touch setup-ran.txt");
    expect(getWorkspace(created.workspaceId).setupState).toBe("running");
  });

  it("a failing scripts.setup does NOT roll the workspace back (background, non-fatal)", async () => {
    await initRepo(repoRoot, `[scripts]\nsetup = "exit 7"\n`);
    // A setup that would fail no longer aborts create — the worktree is kept and
    // the failure surfaces in the Setup tab (where the user can Rerun).
    const created = await createWorkspace({ repoRoot });
    expect(created.setupCommand).toBe("exit 7");
    expect(getWorkspace(created.workspaceId).setupState).toBe("running");
  });

  it("no scripts.setup → create still succeeds", async () => {
    await initRepo(repoRoot); // no settings
    const created = await createWorkspace({ repoRoot });
    expect(getWorkspace(created.workspaceId).path).toBeTruthy();
  });

  it("runRepoScripts:false (the REMOTE create path) does NOT run scripts.setup", async () => {
    await initRepo(repoRoot, `[scripts]\nsetup = "touch setup-ran.txt"\n`);
    const created = await createWorkspace({ repoRoot, runRepoScripts: false });
    const wsPath = getWorkspace(created.workspaceId).path;
    expect(existsSync(path.join(wsPath, "setup-ran.txt"))).toBe(false);
  });

  it("runs scripts.archive before the worktree is removed", async () => {
    // The archive command writes a marker into a stable location (the repo
    // root, via $ZEROS_REPO_ROOT) since the worktree is about to be deleted.
    await initRepo(
      repoRoot,
      `[scripts]\narchive = "touch \\"$ZEROS_REPO_ROOT/archived-ran.txt\\""\n`,
    );
    const created = await createWorkspace({ repoRoot });
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: false,
    });
    expect(existsSync(path.join(repoRoot, "archived-ran.txt"))).toBe(true);
    expect(getWorkspace(created.workspaceId).archivedAt).not.toBeNull();
  });

  it("restores work created by scripts.archive from the final checkpoint", async () => {
    await initRepo(
      repoRoot,
      `[scripts]\narchive = "printf hook-state > archive-hook.txt"\n`,
    );
    const created = await createWorkspace({ repoRoot });
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: false,
    });
    const restored = await restoreWorkspace(created.workspaceId);
    expect(
      await readFile(path.join(restored.path, "archive-hook.txt"), "utf8"),
    ).toBe("hook-state");
  });

  it("a failing scripts.archive does NOT block archiving", async () => {
    await initRepo(repoRoot, `[scripts]\narchive = "exit 3"\n`);
    const created = await createWorkspace({ repoRoot });
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: false,
    });
    expect(getWorkspace(created.workspaceId).archivedAt).not.toBeNull();
  });
});
