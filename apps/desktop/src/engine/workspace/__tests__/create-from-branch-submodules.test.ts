// workspace.createFromBranch creates a new Local workspace, so it runs the same
// post-create submodule step as workspace.create, before setup.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceService } from "../service";
import { closeState, setStateRootForTesting } from "../../git";
import { opSettingsWrite } from "../../settings/ops";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

let root: string;
let repoRoot: string;
const previousSettings = process.env.ZEROS_USER_SETTINGS_DIR;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "zeros-branch-submodules-")));
  process.env.ZEROS_USER_SETTINGS_DIR = path.join(root, "user-settings");
  setStateRootForTesting(path.join(root, "state"));
  repoRoot = path.join(root, "repo");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, env: { ...process.env, ...GIT_ENV }, stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "main", repoRoot]);
  writeFileSync(path.join(repoRoot, "README.md"), "# repo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("branch", "feature/submodules");
  opSettingsWrite("repo-local", { scripts: { setup: "echo setup" } }, repoRoot);
});

afterEach(() => {
  closeState();
  setStateRootForTesting(null);
  if (previousSettings === undefined) delete process.env.ZEROS_USER_SETTINGS_DIR;
  else process.env.ZEROS_USER_SETTINGS_DIR = previousSettings;
  rmSync(root, { recursive: true, force: true });
});

describe("workspace.createFromBranch post-create chain", () => {
  it("fetches submodules before setup for the new workspace", async () => {
    const svc = new WorkspaceService(repoRoot);
    const order: string[] = [];
    let finishSubmodules!: () => void;
    const fetcher = vi.fn(
      (workspaceId: string) =>
        new Promise<void>((resolve) => {
          order.push(`submodules:${workspaceId}`);
          finishSubmodules = resolve;
        }),
    );
    const setup = vi.fn(async (workspaceId: string) => {
      order.push(`setup:${workspaceId}`);
    });
    svc.setSubmoduleFetcher(fetcher);
    svc.setSetupRunner(setup);

    const result = (await svc.handle("workspace.createFromBranch", {
      repoRoot,
      repoSlug: "repo",
      branchName: "feature/submodules",
    })) as { workspaceId: string };

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith(result.workspaceId));
    expect(setup).not.toHaveBeenCalled();
    finishSubmodules();
    await vi.waitFor(() => expect(setup).toHaveBeenCalled());
    expect(order).toEqual([
      `submodules:${result.workspaceId}`,
      `setup:${result.workspaceId}`,
    ]);
  });
});
