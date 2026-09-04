// Detach-mode acceptance coverage using a real filesystem watcher.
//
// Note: these tests use a real chokidar watcher. Watcher events are
// debounced 150ms; we wait 2 seconds on the "edit in workspace → root
// updates" path to give the kernel + watcher pipeline breathing room.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  rm,
  rename,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  closeState,
  createWorkspace,
  detachStart,
  detachStatus,
  detachStop,
  setStateRootForTesting,
} from "..";

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function initRepo(repoRoot: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  await execFileAsync("git", [
    "remote",
    "add",
    "origin",
    "https://example.com/d/t.git",
  ], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "README.md"), "# root\n");
  await writeFile(path.join(repoRoot, "src.txt"), "root content\n");
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
}

describe("detach mode", () => {
  let workdir: string;
  let repoRoot: string;
  let stateRoot: string;
  let workspaceId: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-detach-test-"));
    repoRoot = path.join(workdir, "repo");
    stateRoot = path.join(workdir, "state");
    setStateRootForTesting(stateRoot);
    await initRepo(repoRoot);
    const created = await createWorkspace({ repoRoot });
    workspaceId = created.workspaceId;
  });

  afterEach(async () => {
    // Always try to stop in case a test failed mid-flight.
    try {
      if (detachStatus().active) {
        await detachStop();
      }
    } catch {
      /* best effort */
    }
    closeState();
    setStateRootForTesting(null);
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("start → root files match workspace", async () => {
    // Make the workspace diverge from root.
    const { getWorkspace } = await import("..");
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, "src.txt"), "workspace content\n");

    const result = await detachStart({ workspaceId });
    expect(result.checkpointSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.rootHead).toMatch(/^[0-9a-f]{40}$/);

    // Root's src.txt should now match the workspace.
    const rootSrc = await readFile(path.join(repoRoot, "src.txt"), "utf8");
    expect(rootSrc).toBe("workspace content\n");
  });

  it("mirrors tracked Code without committing the branch, touching the index, or projecting the live Design draft", async () => {
    const { getWorkspace } = await import("..");
    const ws = getWorkspace(workspaceId);
    const designDir = path.join(ws.path, "Zeros Design");
    await mkdir(designDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(designDir, ".zeros-canvas.json"), "{}\n"),
      writeFile(path.join(designDir, "frame.html"), "committed design\n"),
    ]);
    await execFileAsync("git", ["add", "--", "Zeros Design"], {
      cwd: ws.path,
    });
    await execFileAsync("git", ["commit", "-q", "-m", "Design base"], {
      cwd: ws.path,
    });
    await Promise.all([
      writeFile(path.join(ws.path, "src.txt"), "live code\n"),
      writeFile(path.join(designDir, "frame.html"), "live design\n"),
    ]);
    await execFileAsync(
      "git",
      ["add", "--", "Zeros Design/frame.html"],
      { cwd: ws.path },
    );
    const headBefore = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ws.path })
    ).stdout.trim();
    const stagedBefore = (
      await execFileAsync("git", ["diff", "--cached", "--name-only"], {
        cwd: ws.path,
      })
    ).stdout;

    await detachStart({ workspaceId });

    const headAfter = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ws.path })
    ).stdout.trim();
    const stagedAfter = (
      await execFileAsync("git", ["diff", "--cached", "--name-only"], {
        cwd: ws.path,
      })
    ).stdout;
    expect(headAfter).toBe(headBefore);
    expect(stagedAfter).toBe(stagedBefore);
    await expect(readFile(path.join(repoRoot, "src.txt"), "utf8")).resolves.toBe(
      "live code\n",
    );
    await expect(
      readFile(path.join(repoRoot, "Zeros Design", "frame.html"), "utf8"),
    ).resolves.toBe("committed design\n");
  });

  it("edit in workspace while detached → root updates", async () => {
    const { getWorkspace } = await import("..");
    const ws = getWorkspace(workspaceId);

    await detachStart({ workspaceId });

    // Modify a tracked file in the workspace.
    await writeFile(path.join(ws.path, "src.txt"), "edited later\n");

    // Wait for watcher → debounce → checkpoint → read-tree.
    // 2s is the slack we allow; the debounce is 150ms so the real
    // latency is usually ~300ms.
    await sleep(2_000);

    const rootSrc = await readFile(path.join(repoRoot, "src.txt"), "utf8");
    expect(rootSrc).toBe("edited later\n");
  });

  it("stop → root files restored to pre-detach state", async () => {
    const { getWorkspace } = await import("..");
    const ws = getWorkspace(workspaceId);

    await writeFile(path.join(ws.path, "src.txt"), "from workspace\n");

    await detachStart({ workspaceId });
    expect(
      await readFile(path.join(repoRoot, "src.txt"), "utf8"),
    ).toBe("from workspace\n");

    await detachStop();
    expect(
      await readFile(path.join(repoRoot, "src.txt"), "utf8"),
    ).toBe("root content\n");
    expect(detachStatus().active).toBe(false);
  });

  it("retains active state and permits retry when root restoration fails", async () => {
    await detachStart({ workspaceId });
    const displacedRoot = `${repoRoot}-temporarily-unavailable`;
    await rename(repoRoot, displacedRoot);
    try {
      await expect(detachStop()).rejects.toBeTruthy();
      expect(detachStatus()).toMatchObject({ active: true, workspaceId });
    } finally {
      await rename(displacedRoot, repoRoot);
    }

    await expect(detachStop()).resolves.toMatchObject({
      restoredHead: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(detachStatus().active).toBe(false);
  });

  it("refuses to start when root has active rebase", async () => {
    // Fake a rebase-in-progress on the root.
    await mkdir(path.join(repoRoot, ".git", "rebase-apply"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".git", "rebase-apply", "head-name"),
      "refs/heads/main\n",
    );
    await expect(detachStart({ workspaceId })).rejects.toMatchObject({
      code: "REBASE_IN_PROGRESS",
    });
  });

  it("refuses second concurrent detach in same process", async () => {
    await detachStart({ workspaceId });
    await expect(detachStart({ workspaceId })).rejects.toMatchObject({
      code: "DETACH_LOCKED",
    });
  });

  it("detachStatus reports active state", async () => {
    expect(detachStatus().active).toBe(false);
    await detachStart({ workspaceId });
    const status = detachStatus();
    expect(status.active).toBe(true);
    expect(status.workspaceId).toBe(workspaceId);
    expect(status.startedAt).toBeGreaterThan(0);
  });
});
