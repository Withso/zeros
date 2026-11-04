import { describe, expect, it } from "vitest";

import { resolveReviewProvider } from "../review-provider";

describe("review provider routing", () => {
  it("routes every supported github.com transport host to the GitHub provider", () => {
    for (const host of ["github.com", "www.github.com", "ssh.github.com"]) {
      expect(resolveReviewProvider(host)).toMatchObject({
        family: "github",
        hostOrigin: "github.com",
        hostLabel: "GitHub",
        capabilities: {
          reviewNoun: "pull request",
          mergeMethods: [
            { id: "squash", label: "Squash and merge" },
            { id: "merge", label: "Create a merge commit" },
            { id: "rebase", label: "Rebase and merge" },
          ],
        },
      });
    }
  });

  it("does not silently route unsupported or missing hosts through GitHub", () => {
    expect(resolveReviewProvider("gitlab.com")).toBeNull();
    expect(resolveReviewProvider("github.com.example")).toBeNull();
    expect(resolveReviewProvider(null)).toBeNull();
  });
});
