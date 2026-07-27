import { describe, it, expect } from "vitest";

import {
  buildPrInstructions,
  prBubbleDisplayText,
} from "../pr-instructions";

describe("buildPrInstructions", () => {
  it("interpolates branch, target, and the exact push/create commands", () => {
    const out = buildPrInstructions({
      branch: "zeros/my-feature",
      baseBranch: "main",
      uncommittedCount: 18,
      hasUpstream: false,
      draft: false,
    });
    expect(out).toContain("There are 18 uncommitted changes.");
    expect(out).toContain("The current branch is zeros/my-feature.");
    expect(out).toContain("The target branch is origin/main.");
    expect(out).toContain("There is no upstream branch yet.");
    expect(out).toContain("The user requested a PR.");
    expect(out).toContain("git push -u 'origin' HEAD:'zeros/my-feature'");
    expect(out).toContain("gh pr create --base main");
    expect(out).not.toContain("--draft");
  });

  it("pluralizes / singularizes / zeroes the uncommitted line", () => {
    const zero = buildPrInstructions({
      branch: "b",
      baseBranch: "main",
      uncommittedCount: 0,
      hasUpstream: true,
      draft: false,
    });
    expect(zero).toContain("There are no uncommitted changes.");
    expect(zero).toContain("The branch already has an upstream on origin.");

    const one = buildPrInstructions({
      branch: "b",
      baseBranch: "main",
      uncommittedCount: 1,
      hasUpstream: true,
      draft: false,
    });
    expect(one).toContain("There is 1 uncommitted change.");
  });

  it("draft mode changes wording and adds --draft", () => {
    const out = buildPrInstructions({
      branch: "b",
      baseBranch: "dev",
      uncommittedCount: 2,
      hasUpstream: true,
      draft: true,
    });
    expect(out).toContain("The user requested a draft PR.");
    expect(out).toContain("gh pr create --draft --base dev");
  });

  it("names the configured remote everywhere origin appeared", () => {
    const out = buildPrInstructions({
      branch: "zeros/my-feature",
      baseBranch: "dev",
      remote: "upstream",
      uncommittedCount: 0,
      hasUpstream: true,
      draft: false,
    });
    expect(out).toContain("The target branch is upstream/dev.");
    expect(out).toContain("The branch already has an upstream on upstream.");
    expect(out).toContain("git push -u 'upstream' HEAD:'zeros/my-feature'");
    expect(out).not.toContain("origin");
  });
});

describe("prBubbleDisplayText", () => {
  it("matches the requested/draft phrasing", () => {
    expect(prBubbleDisplayText(false)).toBe("Create a PR");
    expect(prBubbleDisplayText(true)).toBe("Create a draft PR");
  });
});
