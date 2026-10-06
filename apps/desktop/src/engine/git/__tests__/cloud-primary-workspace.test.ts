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
  insertWorkspace,
} from "../state";
import { ensureCloudPrimaryWorkspace } from "../cloud-primary-workspace";
import { status } from "../diff";

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

  it.each(["default", "branch", "pull_request"])("registers accepted %s metadata instead of inferring a SHA target", async kind => {
    const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    const source = { kind, revision: head, headBranch: kind === "default" ? "main" : "feature/topic",
      targetBranch: kind === "pull_request" ? "release/stable" : "main",
      pullRequest: kind === "pull_request" ? { number: 42, url: "https://github.com/example/repo/pull/42", state: "ready" } : null };
    await runGit(root, ["config", "--local", "zeros.cloud-source", JSON.stringify(source)]);
    await writeFile(path.join(root, ".git/FETCH_HEAD"), `${head}\t\t${head} of https://github.com/example/repo\n`);
    if (kind !== "default") await runGit(root, ["checkout", "-b", "feature/topic"]);
    const row = await ensureCloudPrimaryWorkspace(root, owner);
    expect(row.baseBranch).toBe(source.targetBranch);
    if (kind === "default") expect(row.branch).toMatch(/^zeros\/[A-Z][a-z]+$/);
    else expect(row.branch).toBe("feature/topic");
    expect(row.prNumber).toBe(source.pullRequest?.number ?? null);
    expect(row.prUrl).toBe(source.pullRequest?.url ?? null);
    expect(row.prState).toBe(source.pullRequest?.state ?? null);
    closeState();
    expect(await ensureCloudPrimaryWorkspace(root, owner)).toMatchObject({ branch: row.branch, baseBranch: row.baseBranch, prNumber: row.prNumber });
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

  it("retains commits made by an admitted setup hook before first engine registration", async () => {
    const accepted = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    await runGit(root, ["config", "--local", "zeros.cloud-source", JSON.stringify({ kind: "default", revision: accepted,
      headBranch: "main", targetBranch: "main", pullRequest: null })]);
    await runGit(root, ["commit", "--allow-empty", "-m", "Setup hook commit"]);
    const hookHead = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    const row = await ensureCloudPrimaryWorkspace(root, owner);
    expect(row.baseBranch).toBe("main");
    expect((await runGit(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(hookHead);
  });

  it("repairs a legacy SHA target without replacing the saved branch, PR or edits", async () => {
    const original = await ensureCloudPrimaryWorkspace(root, owner);
    const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    updateWorkspace("local-main", { baseBranch: head, prNumber: 42 });
    await writeFile(path.join(root, "file.txt"), "staged");
    await runGit(root, ["add", "file.txt"]);
    await writeFile(path.join(root, "file.txt"), "unstaged");
    closeState();
    const row = await ensureCloudPrimaryWorkspace(root, owner);
    expect(row).toMatchObject({ branch: original.branch, baseBranch: "main", prNumber: 42 });
    expect((await runGit(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect((await runGit(root, ["show", ":file.txt"])).stdout).toBe("staged");
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("unstaged");
    expect(getWorkspaceById("local-main")?.baseBranch).toBe("main");
  });

  it("reports current shallow history and clears the warning after explicit deepening", async () => {
    await ensureCloudPrimaryWorkspace(root, owner);
    expect((await status("local-main")).shallow).toBe(false);
    const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(root, ".git/shallow"), `${head}\n`);
    expect((await status("local-main")).shallow).toBe(true);
    await rm(path.join(root, ".git/shallow"));
    expect((await status("local-main")).shallow).toBe(false);
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
  it("refuses to reinterpret or change a Local workspace row", async () => {
    insertWorkspace({ id: "local-main", canonicalId: owner.workspaceId, organizationId: owner.organizationId,
      placement: "local", kind: "code", path: root, repoRoot: root, repoSlug: "example/repo", branch: "main",
      baseBranch: "main", status: "in-progress", createdAt: 0, archivedAt: null, stashRef: null,
      prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: null });
    const before = getWorkspaceById("local-main");
    const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout;
    await expect(ensureCloudPrimaryWorkspace(root, owner)).rejects.toThrow(/identity/);
    expect(getWorkspaceById("local-main")).toEqual(before);
    expect((await runGit(root, ["rev-parse", "HEAD"])).stdout).toBe(head);
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
