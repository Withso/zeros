import { describe, expect, it } from "vitest";

import { githubAppErrorReason } from "../../../native/git";
import { githubAppErrorCopy } from "../github-app-notifications";

describe("GitHub App notification copy", () => {
  // The reported failure: a control plane with no GitHub routes answered its
  // generic 404, and Settings rendered
  // "Error invoking remote method 'zeros:invoke': GithubAppClientError: Not
  // found". Retrying can never help, so the copy has to name the real state and
  // point at the two methods that do work.
  it("explains an unconfigured control plane instead of offering a retry", () => {
    const copy = githubAppErrorCopy("not_configured");

    expect(copy?.title).toMatch(/isn’t available/);
    expect(copy?.description).toMatch(/gh CLI or a Personal Access Token/);
    expect(copy?.description).not.toMatch(/try again/i);
  });

  it("recovers the reason main tagged onto a rejected command", () => {
    const tagged = Object.assign(new Error("nope"), {
      code: "not_configured",
    });
    expect(githubAppErrorReason(tagged)).toBe("not_configured");
    // A GitError code is a different vocabulary and must not be mistaken for a
    // flow reason — the caller falls back to the error's own sentence.
    expect(
      githubAppErrorReason(
        Object.assign(new Error("nope"), { code: "NOT_AUTHENTICATED" }),
      ),
    ).toBeNull();
    expect(githubAppErrorReason(new Error("nope"))).toBeNull();
  });

  it("does not toast a user-cancelled browser consent flow", () => {
    expect(githubAppErrorCopy("access_denied")).toBeNull();
  });

  it("uses actionable bottom-right toast copy for real failures", () => {
    expect(githubAppErrorCopy("handoff_expired")).toEqual({
      title: "GitHub connection expired",
      description: "Start the connection again from Settings.",
    });
    expect(githubAppErrorCopy("github_unavailable")).toMatchObject({
      title: "GitHub is temporarily unavailable",
    });
  });
});
