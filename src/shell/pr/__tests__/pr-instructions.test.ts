import { describe, it, expect } from "vitest";

import { buildPrInstructions, prBubbleDisplayText } from "../pr-instructions";

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
    expect(out).toContain("gh pr create --base 'main'");
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
    expect(out).toContain("gh pr create --draft --base 'dev'");
  });

  // The direct button refuses a conflicted tree and offers "Ask agent" as the
  // recovery — a brief that opened with "the user likes the current state of the
  // code" and never mentioned the conflict would send the agent to commit
  // `<<<<<<<` markers.
  it("puts an unresolved conflict first, before the commit step", () => {
    const out = buildPrInstructions({
      branch: "b",
      baseBranch: "main",
      uncommittedCount: 3,
      conflictedCount: 2,
      hasUpstream: true,
      draft: false,
    });
    expect(out).toContain("2 files have unresolved merge conflicts");
    expect(out.indexOf("conflict")).toBeLessThan(out.indexOf("Commit them"));
    expect(out).toContain("Resolve them first");
  });

  it("names an operation still in flight", () => {
    const out = buildPrInstructions({
      branch: "b",
      baseBranch: "main",
      uncommittedCount: 1,
      operationInProgress: "rebase",
      hasUpstream: true,
      draft: false,
    });
    expect(out).toContain("A rebase is in progress");
  });

  it("says nothing about conflicts on a clean-enough tree", () => {
    const out = buildPrInstructions({
      branch: "b",
      baseBranch: "main",
      uncommittedCount: 1,
      conflictedCount: 0,
      operationInProgress: null,
      hasUpstream: true,
      draft: false,
    });
    expect(out).not.toMatch(/conflict/i);
    expect(out).not.toMatch(/in progress/i);
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

  it("reports failed probes as unknown instead of inventing a clean tree and missing upstream", () => {
    const out = buildPrInstructions({
      branch: "zeros/my-feature",
      baseBranch: "main",
      remote: "origin",
      uncommittedCount: null,
      statusKnown: false,
      hasUpstream: null,
      draft: false,
    });
    expect(out).toContain("could not be read");
    expect(out).toContain("Inspect the worktree for unresolved conflicts");
    expect(out).toContain(
      "If the inspection finds uncommitted changes, commit them",
    );
    expect(out).not.toContain("There are no uncommitted changes.");
    expect(out).not.toContain("There is no upstream branch yet.");
    expect(out).not.toContain("Commit them.");
  });

  it("does not instruct the agent to create an empty commit on a confirmed clean tree", () => {
    const out = buildPrInstructions({
      branch: "zeros/my-feature",
      baseBranch: "main",
      uncommittedCount: 0,
      statusKnown: true,
      hasUpstream: true,
      draft: false,
    });
    expect(out).toContain("Do not create an empty commit");
    expect(out).not.toContain("- Commit them.");
  });

  it("shell-quotes unusual but legal refs and pins gh to the configured repository", () => {
    const out = buildPrInstructions({
      branch: "zeros/o'clock",
      baseBranch: "release/$next",
      remote: "team's-fork",
      repository: "withso/zeros",
      uncommittedCount: 0,
      statusKnown: true,
      hasUpstream: true,
      draft: false,
    });
    expect(out).toContain(
      "git push -u 'team'\\''s-fork' HEAD:'zeros/o'\\''clock'",
    );
    expect(out).toContain(
      "gh pr create --repo 'withso/zeros' --base 'release/$next'",
    );
  });
});

describe("prBubbleDisplayText", () => {
  it("matches the requested/draft phrasing", () => {
    expect(prBubbleDisplayText(false)).toBe("Create a PR");
    expect(prBubbleDisplayText(true)).toBe("Create a draft PR");
  });
});
