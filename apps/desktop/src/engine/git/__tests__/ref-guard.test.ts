import { describe, it, expect } from "vitest";
import { assertSafeGitRef } from "../git-exec";
import { GitError } from "../errors";

describe("assertSafeGitRef (git flag-injection guard)", () => {
  it("rejects values that git would read as an option", () => {
    // The rebase --exec RCE vector and the `git branch -D` deletion vector.
    expect(() => assertSafeGitRef("--exec=touch /tmp/pwned", "ontoBranch")).toThrow();
    expect(() => assertSafeGitRef("-D", "newBranchName")).toThrow();
    expect(() => assertSafeGitRef("--detach", "branchName")).toThrow();
    // The pack-program RCE vectors via a malicious `remote` (push/pull/fetch).
    expect(() => assertSafeGitRef("--upload-pack=touch /tmp/pwned", "remote")).toThrow();
    expect(() => assertSafeGitRef("--receive-pack=touch /tmp/pwned", "remote")).toThrow();
  });

  it("allows a normal remote name", () => {
    expect(() => assertSafeGitRef("origin", "remote")).not.toThrow();
    expect(() => assertSafeGitRef("upstream", "remote")).not.toThrow();
  });

  it("allows legitimate refs (branches, paths, SHAs, stash refs)", () => {
    expect(() => assertSafeGitRef("main", "branchName")).not.toThrow();
    expect(() => assertSafeGitRef("feature/foo-bar", "branchName")).not.toThrow();
    expect(() => assertSafeGitRef("zeros/lily-9f3a", "newBranchName")).not.toThrow();
    expect(() => assertSafeGitRef("stash@{0}", "stashRef")).not.toThrow();
    expect(() => assertSafeGitRef("a1b2c3d4", "sourceBranch")).not.toThrow();
  });

  it("throws a GitError(VALIDATION_FAILED)", () => {
    try {
      assertSafeGitRef("-x", "ontoBranch");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GitError);
      expect((e as GitError).code).toBe("VALIDATION_FAILED");
    }
  });
});
