import { describe, expect, it } from "vitest";
import {
  CloudGithubPrRequestSchema,
  CloudGithubCheckoutSchema,
} from "../cloud-github-pr";
import {
  CloudGithubPrRequestSchema as server,
  CloudGithubCheckoutSchema as checkout,
} from "../../../../apps/control-plane/src/cloud/github-pr-contract";

const authority = {
  connectionGeneration: "generation-1",
  repositoryId: "42",
  repository: "example/project",
  branch: "work",
  baseBranch: "main",
  contextRevision: "boot-1:3",
};
describe("cloud GitHub protocol parity", () => {
  it.each([
    [{ op: "gh.authStatus", params: {} }, true],
    [{ op: "gh.prGet", params: { prNumber: 7 } }, true],
    [{ op: "gh.prSync", params: {} }, true],
    [
      {
        op: "gh.prCreate",
        params: { title: "Change", body: "Description" },
        expected: authority,
      },
      true,
    ],
    [
      { op: "gh.prCreate", params: { title: "Change", body: "Description" } },
      false,
    ],
    [
      {
        op: "gh.prMerge",
        params: {
          prNumber: 7,
          method: "squash",
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
        },
        expected: authority,
      },
      true,
    ],
    [
      {
        op: "gh.prMerge",
        params: { prNumber: 7, method: "squash" },
        expected: authority,
      },
      false,
    ],
    [
      {
        op: "gh.prComment",
        params: {
          kind: "line",
          prNumber: 7,
          body: "Review",
          path: "../secret",
          side: "RIGHT",
          line: 1,
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
        },
        expected: authority,
      },
      false,
    ],
    [{ op: "gh.prGet", params: { prNumber: 7, owner: "another" } }, false],
    [{ op: "gh.arbitraryApi", params: { path: "/user" } }, false],
  ])("agrees on closed request %j", (value, accepted) => {
    expect(CloudGithubPrRequestSchema.safeParse(value).success).toBe(accepted);
    expect(server.safeParse(value).success).toBe(accepted);
  });
  it("does not let worker checkout reports retarget a repository", () => {
    const valid = {
      sequence: 1,
      branch: "work",
      baseBranch: "main",
      headSha: "a".repeat(40),
    };
    for (const schema of [CloudGithubCheckoutSchema, checkout]) {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(
        schema.safeParse({ ...valid, repository: "other/repo" }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...valid, branch: null, headSha: null }).success,
      ).toBe(true);
      expect(schema.safeParse({ ...valid, sequence: 0 }).success).toBe(false);
    }
  });
});
