// Direct commits use the engine's hardened Git, which never runs LFS filters
// and never signs. A commit that would be wrong for this repository is refused
// with a pointer to the agent route or the terminal, which use the user's Git.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  setStateRootForTesting,
  stagePaths,
} from "..";

const execFileAsync = promisify(execFile);

describe("direct commit caveats", () => {
  let workdir: string;
  let repoRoot: string;
  let workspaceId: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-commit-caveats-"));
    repoRoot = path.join(workdir, "repo");
    const bare = path.join(workdir, "remote.git");
    await mkdir(repoRoot, { recursive: true });
    const git = (args: string[], cwd = repoRoot) => execFileAsync("git", args, { cwd });
    await git(["init", "-q", "-b", "main"]);
    await execFileAsync("git", ["init", "-q", "--bare", bare]);
    await git(["remote", "add", "origin", bare]);
    await git(["config", "user.email", "t@t"]);
    await git(["config", "user.name", "t"]);
    await writeFile(path.join(repoRoot, "README.md"), "# initial\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "initial"]);
    await git(["push", "-q", "-u", "origin", "main"]);
    setStateRootForTesting(path.join(workdir, "state"));
    workspaceId = (await createWorkspace({ repoRoot })).workspaceId;
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  });

  const head = async (cwd: string) => (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();

  it("refuses a direct commit that includes Git LFS-tracked files and creates no commit", async () => {
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, ".gitattributes"), "assets/model.bin filter=lfs diff=lfs merge=lfs -text\n");
    await mkdir(path.join(ws.path, "assets"), { recursive: true });
    await writeFile(path.join(ws.path, "assets", "model.bin"), "binary payload\n");
    await stagePaths({ workspaceId, paths: [".gitattributes", "assets/model.bin"] });
    const before = await head(ws.path);
    await expect(commit({ workspaceId, message: "add model" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/Git LFS/),
      remediation: expect.stringMatching(/terminal/),
    });
    expect(await head(ws.path)).toBe(before);
  });

  it("refuses a direct commit when the user's Git config signs commits", async () => {
    const ws = getWorkspace(workspaceId);
    await execFileAsync("git", ["config", "commit.gpgSign", "true"], { cwd: repoRoot });
    await writeFile(path.join(ws.path, "notes.txt"), "hello\n");
    await stagePaths({ workspaceId, paths: ["notes.txt"] });
    const before = await head(ws.path);
    await expect(commit({ workspaceId, message: "add notes" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/sign/i),
      remediation: expect.stringMatching(/terminal/),
    });
    expect(await head(ws.path)).toBe(before);
  });

  it("still commits ordinary files when neither LFS nor signing applies", async () => {
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, "notes.txt"), "hello\n");
    await stagePaths({ workspaceId, paths: ["notes.txt"] });
    await expect(commit({ workspaceId, message: "add notes" })).resolves.toMatchObject({ sha: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });
});
