import { describe, it, expect } from "vitest";

import {
  buildActionPrompt,
  buildFixCheckPrompt,
  buildReviewCommentContext,
  promptActionBubble,
} from "../pr-action-prompts";
import type { PrIslandActionKind } from "../pr-status";

const ctx = { baseBranch: "main" };

describe("buildActionPrompt", () => {
  it("keeps persisted action prompt wording stable", () => {
    expect(buildActionPrompt("resolve", ctx)).toBe(
      "Merge the remote branch (main) into your branch and resolve conflicts. Then, commit and push your changes",
    );
    expect(buildActionPrompt("commit-and-push", ctx)).toBe(
      "Commit and push all changes",
    );
    expect(buildActionPrompt("update-from-base", ctx)).toBe(
      "Merge origin/main into this branch and resolve conflicts if any. Then push.",
    );
  });

  it("direct actions and navigation have no prompt", () => {
    (
      [
        "push",
        "pull",
        "ready-for-review",
        "continue",
        "merge",
        "archive",
        "show-checks",
      ] as PrIslandActionKind[]
    ).forEach((k) => {
      expect(buildActionPrompt(k, ctx)).toBeNull();
    });
  });

  it("names the configured remote / base in the update prompt", () => {
    const up = { ...ctx, remote: "upstream", baseBranch: "develop" };
    expect(buildActionPrompt("update-from-base", up)).toContain(
      "upstream/develop",
    );
    expect(buildActionPrompt("resolve", up)).toContain("(develop)");
  });
});

describe("promptActionBubble", () => {
  it("prompt actions get a short label + autoAction kind", () => {
    expect(promptActionBubble("resolve")).toEqual({
      label: "Resolve",
      autoAction: "resolve",
    });
    expect(promptActionBubble("commit-and-push")).toEqual({
      label: "Commit & Push",
      autoAction: "commit-and-push",
    });
    expect(promptActionBubble("update-from-base")).toEqual({
      label: "Update branch",
      autoAction: "update-branch",
    });
  });

  it("non-prompt actions have no bubble", () => {
    (["push", "pull", "merge", "archive"] as PrIslandActionKind[]).forEach(
      (k) => expect(promptActionBubble(k)).toBeNull(),
    );
  });
});

describe("buildFixCheckPrompt", () => {
  it("names the check, PR, branch, and the log commands", () => {
    const p = buildFixCheckPrompt({
      checkName: "Preflight / test",
      prNumber: 42,
      branch: "zeros/foo",
      detailsUrl: "https://github.com/o/r/actions/runs/1",
    });
    expect(p).toContain("`Preflight / test`");
    expect(p).toContain("PR #42");
    expect(p).toContain("`zeros/foo`");
    expect(p).toContain("https://github.com/o/r/actions/runs/1");
    expect(p).toContain("gh pr checks 42");
    expect(p).toContain("--log-failed");
  });

  it("omits the details line when there's no URL", () => {
    const p = buildFixCheckPrompt({
      checkName: "lint",
      prNumber: 1,
      branch: "b",
      detailsUrl: null,
    });
    expect(p).not.toContain("Details:");
  });
});

describe("buildReviewCommentContext", () => {
  it("quotes every line and carries the verdict", () => {
    const t = buildReviewCommentContext({
      prNumber: 9,
      author: "octocat",
      state: "CHANGES_REQUESTED",
      body: "line one\nline two",
    });
    expect(t).toContain("PR #9 — @octocat (changes requested):");
    expect(t).toContain("> line one\n> line two");
    expect(t.endsWith("\n\n")).toBe(true);
  });

  it("plain comments get no verdict suffix", () => {
    const t = buildReviewCommentContext({
      prNumber: 9,
      author: "octocat",
      state: "",
      body: "hi",
    });
    expect(t).toContain("@octocat:");
    expect(t).not.toContain("()");
  });
});
