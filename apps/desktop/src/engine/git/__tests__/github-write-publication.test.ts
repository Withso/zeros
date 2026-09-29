import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { githubWritePublication } from "../github-write-publication";
const execFile = promisify(execFileCallback);

it("authorizes the native checked-out branch and rejects detached publication without blocking PR comments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-write-publication-"));
  try {
    await execFile("git", ["init", "-b", "original", directory]);
    await execFile("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial"]);
    await execFile("git", ["-C", directory, "checkout", "-b", "native-branch"]);
    const workspace = { path: directory, branch: "original", baseBranch: "main" };
    for (const operation of ["git.push", "gh.prCreate"])
      expect(await githubWritePublication(workspace, operation)).toEqual({ branch: "native-branch", baseBranch: "main" });
    await execFile("git", ["-C", directory, "checkout", "--detach"]);
    await expect(githubWritePublication(workspace, "git.push")).rejects.toThrow(/detached HEAD/);
    expect(await githubWritePublication(workspace, "gh.prComment")).toEqual({ branch: "original", baseBranch: "main" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
