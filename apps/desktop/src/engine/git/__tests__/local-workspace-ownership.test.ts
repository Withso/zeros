import { describe, expect, it } from "vitest";
import { createWorkspace } from "../worktree";
import { adoptExistingWorktree, createWorkspaceFromBranch } from "../cross-tool";

describe("local workspace creation ownership", () => {
  it("rejects organization creates before accessing a local repository", async () => {
    await expect(createWorkspace({ repoRoot: "/unopened-repository", organizationId: "org_test" }))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/organization.*cloud/i) });
  });

  it("cannot label a local checkout as a provisioned cloud workspace", async () => {
    await expect(createWorkspace({ repoRoot: "/unopened-repository", organizationId: "org_test", placement: "cloud" }))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/organization.*cloud/i) });
  });

  it("rejects branch creation and adoption for organization ownership", async () => {
    for (const create of [
      () => createWorkspaceFromBranch({ repoRoot: "/unopened-repository", branchName: "main", organizationId: "org_test" }),
      () => adoptExistingWorktree({ repoRoot: "/unopened-repository", worktreePath: "/unopened-worktree", branchName: "main", organizationId: "org_test" }),
    ]) await expect(create()).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/organization.*cloud/i) });
  });
});
