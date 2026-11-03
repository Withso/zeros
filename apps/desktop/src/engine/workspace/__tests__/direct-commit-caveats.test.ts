// "Create PR directly" and "Create draft directly" commit through WorkspaceService
// (workspace authority), so the LFS and signing refusals must hold there too.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOCAL_MAIN_WORKSPACE_ID, WorkspaceService } from "../service";
import { closeState, setStateRootForTesting } from "../../git";

const execFileAsync = promisify(execFile);

describe("direct commits through the workspace service", () => {
  let workdir: string;
  let root: string;
  const git = async (...args: string[]) => (await execFileAsync("git", args, { cwd: root })).stdout.trim();

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-service-commit-"));
    root = path.join(workdir, "repo");
    await mkdir(root);
    setStateRootForTesting(path.join(workdir, "state"));
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "commit.gpgSign", "false");
    await git("commit", "-q", "--allow-empty", "-m", "fixture");
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  });

  const commitThroughService = async (paths: string[]) => {
    const service = new WorkspaceService(root);
    await service.handle("git.stage", { workspaceId: LOCAL_MAIN_WORKSPACE_ID, paths });
    return service.handle("git.commit", { workspaceId: LOCAL_MAIN_WORKSPACE_ID, message: "direct commit" });
  };

  it("refuses a staged Git LFS file matched by an exact-path rule", async () => {
    await writeFile(path.join(root, ".gitattributes"), "assets/model.bin filter=lfs diff=lfs merge=lfs -text\n");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "model.bin"), "synthetic payload\n");
    const before = await git("rev-parse", "HEAD");
    await expect(commitThroughService([".gitattributes", "assets/model.bin"])).rejects.toMatchObject({
      code: "VALIDATION_FAILED", message: expect.stringMatching(/Git LFS/),
    });
    expect(await git("rev-parse", "HEAD")).toBe(before);
  });

  it("refuses an unsigned commit when the user's Git config signs commits", async () => {
    await writeFile(path.join(root, "notes.txt"), "synthetic note\n");
    await git("config", "commit.gpgSign", "true");
    const before = await git("rev-parse", "HEAD");
    await expect(commitThroughService(["notes.txt"])).rejects.toMatchObject({
      code: "VALIDATION_FAILED", message: expect.stringMatching(/sign/i),
    });
    expect(await git("rev-parse", "HEAD")).toBe(before);
  });

  it("commits ordinary files", async () => {
    await writeFile(path.join(root, "notes.txt"), "synthetic note\n");
    await expect(commitThroughService(["notes.txt"])).resolves.toMatchObject({ sha: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });
});
