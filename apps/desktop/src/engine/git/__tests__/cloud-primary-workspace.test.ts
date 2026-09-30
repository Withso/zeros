import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../git-exec";
import {
  closeState,
  getWorkspaceById,
  setStateRootForTesting,
  updateWorkspace,
  listRemoteRestrictedWorkspaceIds,
  setWorkspaceRemoteRestricted,
} from "../state";
import { ensureCloudPrimaryWorkspace } from "../cloud-primary-workspace";

const owner = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
};
describe("cloud primary workspace", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-cloud-primary-"));
    setStateRootForTesting(path.join(root, "state"));
    await runGit(root, ["init", "-b", "main"]);
    await runGit(root, ["config", "user.name", "Test"]);
    await runGit(root, ["config", "user.email", "test@example.test"]);
    await runGit(root, [
      "remote",
      "add",
      "origin",
      "https://github.com/example/repo.git",
    ]);
    await writeFile(path.join(root, "file.txt"), "base");
    await runGit(root, ["add", "file.txt"]);
    await runGit(root, ["commit", "-m", "base"]);
    const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(
      path.join(root, ".git/FETCH_HEAD"),
      `${head}\t\tbranch 'main' of https://github.com/example/repo\n`,
    );
    await runGit(root, ["checkout", "--detach"]);
  });
  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    await rm(root, { recursive: true, force: true });
  });

  it("registers the primary checkout for Git and PR operations without another worktree", async () => {
    const row = await ensureCloudPrimaryWorkspace(root, owner);
    expect(row).toMatchObject({
      id: "local-main",
      canonicalId: owner.workspaceId,
      organizationId: owner.organizationId,
      placement: "cloud",
      path: root,
      baseBranch: "main",
      branch: `zeros/cloud-${owner.workspaceId}`,
    });
    expect(getWorkspaceById("local-main")).toMatchObject({
      branch: row.branch,
      repoRoot: root,
    });
  });

  it("preserves staged work, branch selection and PR metadata on restart", async () => {
    await ensureCloudPrimaryWorkspace(root, owner);
    updateWorkspace("local-main", {
      prNumber: 12,
      prUrl: "https://github.com/example/repo/pull/12",
      baseBranch: "release",
    });
    await writeFile(path.join(root, "file.txt"), "staged");
    await runGit(root, ["add", "file.txt"]);
    await writeFile(path.join(root, "file.txt"), "unstaged");
    const row = await ensureCloudPrimaryWorkspace(root, owner);
    expect(row).toMatchObject({ prNumber: 12, baseBranch: "release" });
    expect((await runGit(root, ["show", ":file.txt"])).stdout).toBe("staged");
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(
      "unstaged",
    );
  });

  it("rejects a row from another cloud owner", async () => {
    await ensureCloudPrimaryWorkspace(root, owner);
    await expect(
      ensureCloudPrimaryWorkspace(root, {
        ...owner,
        organizationId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toThrow(/identity/);
  });
  it("keeps Design view separate from cloud authority without weakening explicit relay restrictions", async () => {
    await ensureCloudPrimaryWorkspace(root, owner);
    updateWorkspace("local-main", { viewMode: "design" });
    expect(listRemoteRestrictedWorkspaceIds().has("local-main")).toBe(true);
    expect(listRemoteRestrictedWorkspaceIds(true).has("local-main")).toBe(
      false,
    );
    setWorkspaceRemoteRestricted("local-main", true);
    expect(listRemoteRestrictedWorkspaceIds(true).has("local-main")).toBe(true);
  });
});
