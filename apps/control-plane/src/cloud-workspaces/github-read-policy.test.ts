import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authorizeGithubRead } from "./github-read-policy.js";

const repo = { owner: "org", repository: "repo" };
describe("cloud GitHub read allow-list", () => {
  it.each([
    "", "/branches?per_page=100&page=1", "/pulls?state=open&per_page=50&head=org%3Atopic",
    "/pulls/7", "/pulls/7/commits?per_page=100", "/pulls/7/reviews", "/pulls/7/comments",
    "/issues/7/comments", "/issues/7/timeline", "/commits/abc/check-runs?filter=latest&per_page=100",
    "/commits/abc/statuses", "/commits/abc/status", "/check-runs/8/annotations?page=10&per_page=100",
    "/compare/main...org%3Atopic?per_page=1",
  ])("admits the repository read %s", suffix => {
    expect(authorizeGithubRead(repo, { method: "GET", path: `/repos/org/repo${suffix}`, format: "json" }).path).toContain("/repos/org/repo");
  });
  it.each([
    { method: "POST", path: "/repos/org/repo/issues/7/comments", body: { body: "write" } },
    { method: "GET", path: "/repos/org/other/pulls/7" },
    { method: "GET", path: "https://api.github.com/repos/org/repo/pulls/7" },
    { method: "GET", path: "/repos/org/repo/contents/private" },
    { method: "GET", path: "/repos/org/repo/pulls?per_page=1000" },
    { method: "GET", path: "/repos/org/repo/pulls?page=1000" },
    { method: "GET", path: "/repos/org/repo/pulls?access_token=synthetic" },
    { method: "GET", path: "/repos/org/repo/pulls?state=open&state=closed" },
    { method: "GET", path: "/repos/org/repo/../other/pulls" },
    { method: "GET", path: "/repos/org/repo/compare/main...topic", format: "diff" },
    { method: "POST", path: "/graphql", body: { query: "mutation { dangerous }", variables: {} } },
  ])("rejects arbitrary or unbounded requests", request => {
    expect(() => authorizeGithubRead(repo, { format: "json", ...request })).toThrow();
  });
  it("pins both actual engine GraphQL reads and rejects query/variable expansion", () => {
    const root = new URL("../../../desktop/src/engine/git/", import.meta.url);
    const threads = /const THREADS_QUERY = `([^`]+)`/.exec(readFileSync(new URL("github-inline-review.ts", root), "utf8"))![1]!;
    const stats = /`(query \(\$owner:[\s\S]*?)`/.exec(readFileSync(new URL("github.ts", root), "utf8"))![1]!;
    for (const query of [threads, stats]) {
      const variables = { owner: "org", repo: "repo", number: 7, ...(query === threads ? { after: null } : {}) };
      expect(authorizeGithubRead(repo, { method: "POST", path: "/graphql", body: { query, variables } }).path).toBe("/graphql");
      for (const body of [{ query: query.replace("headRefOid", "headRefOid id") + " query { viewer { login } }", variables }, { query, variables: { ...variables, repo: "other" } }, { query, variables: { ...variables, extra: "no" } }])
        expect(() => authorizeGithubRead(repo, { method: "POST", path: "/graphql", body })).toThrow();
    }
  });
});
