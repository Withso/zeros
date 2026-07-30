// The breadcrumb's branch name across a rename.
//
// `gitRenameBranch` resolves to the branch the ENGINE wrote, and the workspace
// row that normally supplies the label only catches up after a bridge round
// trip. Between those two the breadcrumb has to name something, and until
// 2026-07-30 it named the branch the user had just renamed away from — the
// engine's answer was computed, handed to a callback, and dropped.

import { describe, it, expect } from "vitest";

import {
  optimisticRenamedBranch,
  replaceBranchName,
} from "../column2-topbar";
import { branchDisplayName } from "@/engine/git/branch-naming";

describe("optimisticRenamedBranch", () => {
  it("names the engine's branch while the store still holds the old one", () => {
    expect(
      optimisticRenamedBranch("jordan/Cream", {
        from: "jordan/Cream",
        to: "jordan/login-fix",
      }),
    ).toBe("jordan/login-fix");
  });

  it("steps aside the moment the refetch lands", () => {
    // The store now agrees. Holding the override past this point would latch a
    // value that no longer has anything to say, and would survive a LATER
    // rename made anywhere else.
    expect(
      optimisticRenamedBranch("jordan/login-fix", {
        from: "jordan/Cream",
        to: "jordan/login-fix",
      }),
    ).toBeNull();
  });

  it("steps aside when the user switches to another workspace mid-refetch", () => {
    // Same mount, different row: the override belongs to a workspace that is
    // no longer on screen, so it must not label this one.
    expect(
      optimisticRenamedBranch("jordan/Bone", {
        from: "jordan/Cream",
        to: "jordan/login-fix",
      }),
    ).toBeNull();
  });

  it("is inert with no rename in flight, and on a workspace-less breadcrumb", () => {
    expect(optimisticRenamedBranch("jordan/Cream", null)).toBeNull();
    expect(
      optimisticRenamedBranch(undefined, {
        from: "jordan/Cream",
        to: "jordan/login-fix",
      }),
    ).toBeNull();
  });

  it("survives a second rename inside the same window", () => {
    // A→B still pending when B→C commits: the pair is replaced wholesale, so
    // the override is keyed on B and correctly reports C.
    expect(
      optimisticRenamedBranch("jordan/B", { from: "jordan/B", to: "jordan/C" }),
    ).toBe("jordan/C");
  });

  // The property that actually matters: the label shown DURING the refetch is
  // the one the refetch will produce. The override is a full ref for exactly
  // this reason — the breadcrumb runs branchDisplayName over it, so handing it
  // a bare name would make the optimistic label differ in shape from the one
  // that replaces it and the breadcrumb would visibly re-write itself.
  //
  // Note this pair is `jordan/login-fix` at BOTH ends, not `login-fix`:
  // branchDisplayName concedes a namespace only for `zeros/` or an
  // allocator-shaped tail (branch-naming.ts, "KNOWN IMPRECISION"), and a
  // hand-typed rename is neither. That is pre-existing labelling behaviour;
  // what is pinned here is that the two agree.
  it("produces the same label the landed workspace row will", () => {
    const renamed = { from: "jordan/Cream", to: "jordan/login-fix" };

    const during = optimisticRenamedBranch("jordan/Cream", renamed);
    const after = optimisticRenamedBranch("jordan/login-fix", renamed);

    expect(branchDisplayName(during!)).toBe(
      branchDisplayName(after ?? "jordan/login-fix"),
    );
  });

  it("agrees with the store for an allocator-shaped rename too", () => {
    const renamed = { from: "zeros/Cream", to: "zeros/Bone" };
    expect(branchDisplayName(optimisticRenamedBranch("zeros/Cream", renamed)!)).toBe(
      "Bone",
    );
    expect(branchDisplayName("zeros/Bone")).toBe("Bone");
  });
});

describe("replaceBranchName", () => {
  // Only reached when the engine does not report the resulting branch. It must
  // mirror the engine's own rule — the LAST slash — because a wrong namespace
  // here now paints a wrong breadcrumb rather than being quietly discarded.
  it("keeps whatever namespace the branch already lives in", () => {
    expect(replaceBranchName("jordan/Cream", "login-fix")).toBe(
      "jordan/login-fix",
    );
    expect(replaceBranchName("zeros/Cream", "login-fix")).toBe(
      "zeros/login-fix",
    );
    expect(replaceBranchName("team/squad/Cream", "login-fix")).toBe(
      "team/squad/login-fix",
    );
  });

  it("leaves an unprefixed branch unprefixed", () => {
    // The `none` prefix setting. Hardcoding `zeros/` here is the original bug:
    // it named a ref that was never created.
    expect(replaceBranchName("Cream", "login-fix")).toBe("login-fix");
  });

  it("uses the last slash even when the tail is not allocator-shaped", () => {
    // branchDisplayName would concede no prefix here (the tail isn't a colour
    // name), which is why the fallback cannot be built from it.
    expect(replaceBranchName("cursor/foo", "login-fix")).toBe(
      "cursor/login-fix",
    );
    expect(replaceBranchName("jordan/login-fix", "second-pass")).toBe(
      "jordan/second-pass",
    );
  });
});
