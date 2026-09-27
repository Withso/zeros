import { describe, expect, it } from "vitest";
import {
  cloudSourceRevision,
  cloudSourceRepositoryReason,
} from "../cloud-create";

describe("cloud creation source", () => {
  it("never sends a local tracking namespace to the cloud GitHub resolver", () => {
    expect(
      cloudSourceRevision(
        {
          kind: "branch",
          branch: "refs/remotes/origin/feature/ui",
          source: "github",
          label: "feature/ui",
        },
        null,
      ),
    ).toEqual({ revision: "refs/heads/feature/ui", reason: null });
  });
  it("requires an explicit remote source for a local-only selection", () => {
    expect(
      cloudSourceRevision(
        {
          kind: "branch",
          branch: "refs/heads/private",
          source: "local",
          label: "private",
        },
        "main",
      ).revision,
    ).toBeNull();
  });
  it("keeps a selected pull-request head and an unknown default distinct", () => {
    expect(
      cloudSourceRevision(
        {
          kind: "pr",
          source: "github",
          label: "PR",
          branch: "fork-branch",
          prNumber: 42,
        },
        "main",
      ).revision,
    ).toBe("refs/pull/42/head");
    expect(cloudSourceRevision(null, null).revision).toBeNull();
    expect(cloudSourceRevision(null, "trunk").revision).toBe(
      "refs/heads/trunk",
    );
  });
  it("does not resolve a fork remote's branch against the origin repository", () => {
    const base = {
      kind: "branch",
      source: "github",
      label: "main",
      branch: "refs/remotes/fork/main",
    } as const;
    const remotes = [
      { name: "fork", url: "git@github.com:fork/repo.git", isGitHub: true },
    ];
    expect(
      cloudSourceRepositoryReason(
        base,
        remotes,
        null,
        "https://github.com/origin/repo.git",
      ),
    ).toContain("different repository");
    expect(
      cloudSourceRepositoryReason(
        base,
        remotes,
        null,
        "https://github.com/fork/repo.git",
      ),
    ).toBeNull();
  });
});
