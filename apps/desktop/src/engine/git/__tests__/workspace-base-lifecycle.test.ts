// Repository base-branch changes across the complete workspace lifecycle.
//
// The repo setting is a default for FUTURE workspaces, not mutable ownership
// metadata for existing ones. These integration contracts deliberately mix
// create/archive/restore operations so a settings or concurrency refactor
// cannot silently rebase an older workspace or lose its saved work.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  archiveWorkspace,
  closeState,
  createWorkspace,
  getWorkspace,
  repoBranchCatalog,
  restoreWorkspace,
  setStateRootForTesting,
} from "..";
import { resetFetchFreshness } from "../default-branch";
import { resolveWorkspaceTargetRef } from "../target-branch";
import { opSettingsWrite } from "../../settings";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("repository base branch × workspace lifecycle", () => {
  let workdir: string;
  let repoRoot: string;
  let remoteRoot: string;
  let mainTip: string;
  let releaseTip: string;

  const setBaseBranch = (baseBranch: string | null): void => {
    opSettingsWrite(
      "repo-local",
      { git: { base_branch: baseBranch } },
      repoRoot,
    );
  };

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-base-lifecycle-"));
    repoRoot = path.join(workdir, "repo");
    remoteRoot = path.join(workdir, "remote.git");
    setStateRootForTesting(path.join(workdir, "state"));

    await mkdir(repoRoot, { recursive: true });
    await git(repoRoot, "init", "-q", "-b", "main");
    await git(repoRoot, "config", "user.email", "test@zeros.local");
    await git(repoRoot, "config", "user.name", "Zeros Test");
    await writeFile(path.join(repoRoot, "base.txt"), "main\n");
    await git(repoRoot, "add", ".");
    await git(repoRoot, "commit", "-q", "-m", "main tip");
    mainTip = await git(repoRoot, "rev-parse", "HEAD");

    await execFileAsync("git", [
      "init",
      "-q",
      "--bare",
      "-b",
      "main",
      remoteRoot,
    ]);
    await git(repoRoot, "remote", "add", "origin", remoteRoot);
    await git(repoRoot, "push", "-q", "origin", "main");

    await git(repoRoot, "checkout", "-q", "-b", "release/2026");
    await writeFile(path.join(repoRoot, "release-only.txt"), "release\n");
    await git(repoRoot, "add", ".");
    await git(repoRoot, "commit", "-q", "-m", "release tip");
    releaseTip = await git(repoRoot, "rev-parse", "HEAD");
    await git(repoRoot, "push", "-q", "origin", "release/2026");
    await git(repoRoot, "checkout", "-q", "main");
    await git(repoRoot, "remote", "set-head", "origin", "-a");
    resetFetchFreshness();
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    resetFetchFreshness();
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  });

  it("pins each workspace to the base it actually used while create, archive, and restore overlap", async () => {
    setBaseBranch("main");
    const first = await createWorkspace({
      repoRoot,
      repoSlug: "lifecycle-repo",
    });
    expect(await git(first.path, "rev-parse", "HEAD")).toBe(mainTip);
    expect(getWorkspace(first.workspaceId).baseBranch).toBe("main");
    await writeFile(
      path.join(first.path, "first-untracked.txt"),
      "first WIP\n",
    );

    // Changing the repository default affects the next create only. Archiving
    // an older workspace at the same time must not serialize the whole repo.
    setBaseBranch("release/2026");
    const [, second] = await Promise.all([
      archiveWorkspace({
        workspaceId: first.workspaceId,
        stashUncommitted: true,
      }),
      createWorkspace({ repoRoot, repoSlug: "lifecycle-repo" }),
    ]);
    expect(getWorkspace(first.workspaceId)).toMatchObject({
      baseBranch: "main",
      archivedAt: expect.any(Number),
    });
    expect(await resolveWorkspaceTargetRef(first.workspaceId)).toBe(
      "origin/main",
    );
    expect(getWorkspace(second.workspaceId).baseBranch).toBe("release/2026");
    expect(await git(second.path, "rev-parse", "HEAD")).toBe(releaseTip);
    await writeFile(
      path.join(second.path, "second-untracked.txt"),
      "second WIP\n",
    );

    // Exercise all three independent lifecycle flights together after another
    // settings change. The restored workspace retains main, the archived one
    // retains release/2026, and only the new workspace consumes main.
    setBaseBranch("main");
    const [firstRestore, , third] = await Promise.all([
      restoreWorkspace(first.workspaceId),
      archiveWorkspace({
        workspaceId: second.workspaceId,
        stashUncommitted: true,
      }),
      createWorkspace({ repoRoot, repoSlug: "lifecycle-repo" }),
    ]);
    expect(firstRestore.workspace.baseBranch).toBe("main");
    expect(
      await readFile(
        path.join(firstRestore.path, "first-untracked.txt"),
        "utf8",
      ),
    ).toBe("first WIP\n");
    expect(getWorkspace(second.workspaceId)).toMatchObject({
      baseBranch: "release/2026",
      archivedAt: expect.any(Number),
    });
    expect(getWorkspace(third.workspaceId).baseBranch).toBe("main");
    expect(await git(third.path, "rev-parse", "HEAD")).toBe(mainTip);

    // A later repo-default change still cannot rewrite the archived row or its
    // target ref. Restoring brings back both its original base and saved WIP.
    setBaseBranch("release/2026");
    const secondRestore = await restoreWorkspace(second.workspaceId);
    expect(secondRestore.workspace.baseBranch).toBe("release/2026");
    expect(await resolveWorkspaceTargetRef(second.workspaceId)).toBe(
      "origin/release/2026",
    );
    expect(
      await readFile(
        path.join(secondRestore.path, "second-untracked.txt"),
        "utf8",
      ),
    ).toBe("second WIP\n");
  });

  it("resetting the picker follows the remote HEAD and persists the detected base", async () => {
    await git(remoteRoot, "symbolic-ref", "HEAD", "refs/heads/release/2026");
    await git(repoRoot, "remote", "set-head", "origin", "-a");
    setBaseBranch("main");
    setBaseBranch(null);
    resetFetchFreshness();

    const catalog = await repoBranchCatalog({ repoRoot, fetch: true });
    expect(catalog).toMatchObject({
      baseExplicit: false,
      detectedDefault: "release/2026",
      effectiveBase: "release/2026",
    });

    const created = await createWorkspace({
      repoRoot,
      repoSlug: "lifecycle-repo",
    });
    expect(getWorkspace(created.workspaceId).baseBranch).toBe("release/2026");
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(releaseTip);
  });

  it("uses and records the real local fallback when an explicit remote branch disappeared", async () => {
    setBaseBranch("deleted-after-selection");
    const catalog = await repoBranchCatalog({ repoRoot });
    expect(catalog).toMatchObject({
      baseExplicit: true,
      effectiveBase: "deleted-after-selection",
      branchSource: "remote",
    });
    expect(
      catalog.branches.some(
        (branch) => branch.name === "deleted-after-selection",
      ),
    ).toBe(false);

    const created = await createWorkspace({
      repoRoot,
      repoSlug: "lifecycle-repo",
    });
    // Never stamp the stale setting onto the workspace row: diff/PR/restore
    // consumers must see the base the checkout genuinely used.
    expect(getWorkspace(created.workspaceId).baseBranch).toBe("main");
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(mainTip);
  });
});
