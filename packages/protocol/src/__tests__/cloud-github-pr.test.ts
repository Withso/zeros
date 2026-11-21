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
  // The schema only shapes the name. The control plane binds it to one of the
  // reporting workspace's own repositories and refuses anything else without a
  // write (ready-copies.integration.test.ts, "binds every repository ...").
  it("lets a worker checkout report name a well-formed owner/name repository and refuses any malformed name", () => {
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
      ).toBe(true);
      for (const repository of [
        "",
        "other",
        "other/",
        "/repo",
        "a/b/c",
        "other/repo ",
        "withso/w\u0435b",
        "withso/web\u200b",
        "\uff57ithso/web",
        `${"a".repeat(101)}/repo`,
        42,
        null,
      ])
        expect(
          schema.safeParse({ ...valid, repository }).success,
          String(repository),
        ).toBe(false);
      expect(
        schema.safeParse({ ...valid, repositoryId: "42" }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...valid, branch: null, headSha: null }).success,
      ).toBe(true);
      expect(schema.safeParse({ ...valid, sequence: 0 }).success).toBe(false);
    }
  });
});
