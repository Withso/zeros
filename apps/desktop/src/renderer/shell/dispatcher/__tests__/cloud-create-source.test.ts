import { describe, expect, it } from "vitest";
import { cloudSourceBaseBranch } from "../cloud-create";
import { computerBranchBase, computerPrBase } from "../cloud-computer-source";

// The v2 worker creates the workspace branch with
// `git switch -c <branch> origin/<baseBranch>`: only a plain branch name works.
describe("cloud creation source", () => {
  it("sends a picked remote branch as its plain name", () => {
    expect(cloudSourceBaseBranch(computerBranchBase("feature/ui"))).toEqual({ baseBranch: "feature/ui", reason: null });
  });
  it("strips any remote tracking namespace", () => {
    expect(cloudSourceBaseBranch({ kind: "branch", branch: "refs/remotes/origin/feature/ui", source: "github", label: "feature/ui" }))
      .toEqual({ baseBranch: "feature/ui", reason: null });
  });
  it("starts a pull request's workspace from its head branch", () => {
    const base = computerPrBase({ number: 42, title: "Fix", url: "https://github.com/example/project/pull/42", headBranch: "fix/login" });
    expect(base).toMatchObject({ kind: "pr", prNumber: 42 });
    expect(cloudSourceBaseBranch(base)).toEqual({ baseBranch: "fix/login", reason: null });
  });
  it("leaves the default to the server when nothing is picked", () => {
    expect(cloudSourceBaseBranch(null)).toEqual({ baseBranch: null, reason: null });
  });
  it("requires an explicit remote source for a local-only selection", () => {
    const result = cloudSourceBaseBranch({ kind: "branch", branch: "refs/heads/private", source: "local", label: "private" });
    expect(result.baseBranch).toBeNull();
    expect(result.reason).toContain("Push local-only work");
  });
  it("refuses a ref the worker cannot switch to", () => {
    const result = cloudSourceBaseBranch({ kind: "pr", branch: "refs/pull/7/head", source: "github", label: "#7", prNumber: 7 });
    expect(result.baseBranch).toBeNull();
    expect(result.reason).not.toBeNull();
  });
});
