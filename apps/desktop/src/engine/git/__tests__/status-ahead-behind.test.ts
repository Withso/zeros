// status() now reports the branch's upstream + ahead/behind counts so the PR
// island can offer Push / Pull. Verifies the four shapes: no-upstream (null),
// in-sync (0/0), ahead (local commits unpushed), behind (upstream advanced).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  closeState,
  commit,
  createWorkspace,
  getWorkspace,
  push,
  setStateRootForTesting,
  stagePaths,
  status,
} from "..";

const execFileAsync = promisify(execFile);

async function initRepoWithRemote(repoRoot: string, bareRemotePath: string) {
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  await execFileAsync("git", ["init", "-q", "--bare", bareRemotePath]);
  await execFileAsync("git", ["remote", "add", "origin", bareRemotePath], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "README.md"), "# initial\n");
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], { cwd: repoRoot });
  await execFileAsync("git", ["push", "-q", "-u", "origin", "main"], { cwd: repoRoot });
}

async function commitFile(workspaceId: string, wsPath: string, name: string) {
  await writeFile(path.join(wsPath, name), `${name}\n`);
  await stagePaths({ workspaceId, paths: [name] });
  await commit({ workspaceId, message: `add ${name}` });
}

describe("status() ahead/behind/upstream", () => {
  let workdir: string;
  let repoRoot: string;
  let bareRemote: string;
  let workspaceId: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-status-ab-"));
    repoRoot = path.join(workdir, "repo");
    bareRemote = path.join(workdir, "remote.git");
    setStateRootForTesting(path.join(workdir, "state"));
    await initRepoWithRemote(repoRoot, bareRemote);
    workspaceId = (await createWorkspace({ repoRoot })).workspaceId;
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

  it("reports null upstream + null counts for an unpushed branch", async () => {
    const s = await status(workspaceId);
    expect(s.upstream).toBeNull();
    expect(s.ahead).toBeNull();
    expect(s.behind).toBeNull();
  });

  it("reports the upstream ref and 0/0 right after pushing", async () => {
    const ws = getWorkspace(workspaceId);
    await commitFile(workspaceId, ws.path, "a.txt");
    await push({ workspaceId });
    const s = await status(workspaceId);
    expect(s.upstream).toBe(`origin/${ws.branch}`);
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
  });

  it("reports ahead>0 for local commits not yet pushed", async () => {
    const ws = getWorkspace(workspaceId);
    await commitFile(workspaceId, ws.path, "a.txt");
    await push({ workspaceId });
    await commitFile(workspaceId, ws.path, "b.txt"); // local-only
    const s = await status(workspaceId);
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(0);
  });

  it("reports behind>0 when the upstream advances", async () => {
    const ws = getWorkspace(workspaceId);
    await commitFile(workspaceId, ws.path, "a.txt");
    await push({ workspaceId });

    // Teammate pushes another commit to the same branch upstream.
    const teammate = path.join(workdir, "teammate");
    await execFileAsync("git", ["clone", "-q", bareRemote, teammate]);
    await execFileAsync("git", ["-C", teammate, "config", "user.email", "t2@t"]);
    await execFileAsync("git", ["-C", teammate, "config", "user.name", "t2"]);
    await execFileAsync("git", ["-C", teammate, "checkout", "-q", ws.branch]);
    await writeFile(path.join(teammate, "c.txt"), "c\n");
    await execFileAsync("git", ["-C", teammate, "add", "."]);
    await execFileAsync("git", ["-C", teammate, "commit", "-q", "-m", "teammate"]);
    await execFileAsync("git", ["-C", teammate, "push", "-q"]);

    // Update our remote-tracking ref without merging.
    await execFileAsync("git", ["-C", ws.path, "fetch", "-q"]);
    const s = await status(workspaceId);
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(1);
  });
});
