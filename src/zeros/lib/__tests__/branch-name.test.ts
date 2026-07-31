import { describe, it, expect } from "vitest";

import { branchDisplayName } from "../branch-name";

// The renderer's copy must agree with the engine's (engine/git/naming.ts,
// covered by naming.test.ts) — the engine names the branch, this labels the
// tab, and a disagreement shows up as a workspace whose tab and branch read
// differently. Same cases on both sides, on purpose.

describe("branchDisplayName (renderer)", () => {
  it("strips the legacy zeros/ prefix", () => {
    expect(branchDisplayName("zeros/Cream")).toBe("Cream");
    expect(branchDisplayName("zeros/Cream-v2")).toBe("Cream-v2");
  });

  it("strips an unknown prefix when the tail is an allocated name", () => {
    // How a branch made under a CONFIGURED prefix is recognized without
    // knowing which prefix was in force when it was created.
    expect(branchDisplayName("jordan/Cream")).toBe("Cream");
    expect(branchDisplayName("feature/Cream")).toBe("Cream");
    expect(branchDisplayName("team/squad/Cream")).toBe("Cream");
    expect(branchDisplayName("alice/Cream-v2")).toBe("Cream-v2");
  });

  it("keeps the namespace of a branch Zeros did not name", () => {
    // The load-bearing half of the rule. An adopted worktree or the user's own
    // branch carries its prefix as IDENTITY, not bookkeeping — relabelling
    // `cursor/foo` to `foo` would erase which tool owns it.
    expect(branchDisplayName("cursor/foo")).toBe("cursor/foo");
    expect(branchDisplayName("feature/plain")).toBe("feature/plain");
    expect(branchDisplayName("release/2026-07")).toBe("release/2026-07");
  });

  it("passes through a branch with no prefix", () => {
    expect(branchDisplayName("Cream")).toBe("Cream");
    expect(branchDisplayName("main")).toBe("main");
  });

  it("leaves a non-slash prefix attached", () => {
    // `myname-` has no boundary to cut at, so the whole string IS the label.
    expect(branchDisplayName("myname-Cream")).toBe("myname-Cream");
  });

  it("never produces an empty label", () => {
    // A trailing slash has no allocated name after it, so the ref stands —
    // an empty tab label would be worse than an odd-looking one.
    expect(branchDisplayName("")).toBe("");
    expect(branchDisplayName("trailing/")).toBe("trailing/");
  });
});
