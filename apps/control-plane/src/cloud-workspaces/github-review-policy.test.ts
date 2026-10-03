import { describe, expect, it, vi } from "vitest";
import {
  assertGithubReviewTarget,
  authorizeGithubReviewRequest,
  githubCommentWriteBody,
  githubReviewPreflight,
} from "./github-review-policy.js";
import type { GithubProxyAuthority } from "./github-write-grants.js";
import {
  CLOUD_GITHUB_PROXY_PATH,
  createCloudGithubProxyRoutes,
} from "./github-write-proxy.js";

const sha = "a".repeat(40);
const baseSha = "b".repeat(40);
const scope: GithubProxyAuthority = {
  owner: "org",
  repository: "repo",
  repositoryId: "123",
  operation: "gh.prComment",
  prNumber: 7,
  userToken: "synthetic-user-token",
  expiresAtMs: Date.now() + 10000,
  expectedBody: null,
  gitReference: null,
};
const line = {
  kind: "line",
  body: "Check this range.",
  commitSha: sha,
  baseSha,
  path: "src/auth.ts",
  startLine: 4,
  line: 8,
  side: "LEFT",
};

describe("inline review cloud policy", () => {
  it("refuses a comment if its base changed without a head change", () => {
    const target = { ...scope, expectedBody: githubCommentWriteBody(line) };
    expect(() =>
      assertGithubReviewTarget(target, {
        head: { sha },
        base: { sha: "c".repeat(40) },
      }),
    ).toThrow();
  });
  it("refuses a cross-PR reply before forwarding or spending the write capability", async () => {
    const target = {
      ...scope,
      expectedBody: githubCommentWriteBody({
        kind: "reply",
        commentId: 21,
        body: "Confirmed",
      }),
    };
    const authorizeProxy = vi.fn(async () => target);
    const upstream = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/pulls/comments/21")
        ? Response.json({
            pull_request_url: "https://api.github.com/repos/org/repo/pulls/8",
          })
        : Response.json({ id: 123 }),
    );
    const service = {
      authorizeProxy,
    } as unknown as import("./github-write-grants.js").DatabaseCloudGithubWriteGrants;
    const app = createCloudGithubProxyRoutes(service, upstream);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await app.request(
        `${CLOUD_GITHUB_PROXY_PATH}/api/repos/org/repo/pulls/7/comments/21/replies`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer zgp_${"p".repeat(43)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ body: "Confirmed" }),
        },
      );
      expect(response.status).toBe(403);
      expect(authorizeProxy).toHaveBeenCalledTimes(1);
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(
        upstream.mock.calls.some(([url]) => String(url).endsWith("/replies")),
      ).toBe(false);
    } finally {
      warning.mockRestore();
    }
  });
  it("authorizes a matching PR reply with the user identity only upstream", async () => {
    const target = {
      ...scope,
      expectedBody: githubCommentWriteBody({
        kind: "reply",
        commentId: 21,
        body: "Confirmed",
      }),
    };
    const authorizeProxy = vi.fn(async () => target);
    const upstream = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer synthetic-user-token",
        );
        if (String(url).endsWith("/pulls/comments/21"))
          return Response.json({
            pull_request_url: "https://api.github.com/repos/org/repo/pulls/7",
          });
        if (String(url).endsWith("/replies")) {
          expect(init?.body).toBe(JSON.stringify({ body: "Confirmed" }));
          return Response.json({ id: 22 }, { status: 201 });
        }
        return Response.json({ id: 123 });
      },
    );
    const service = {
      authorizeProxy,
    } as unknown as import("./github-write-grants.js").DatabaseCloudGithubWriteGrants;
    const app = createCloudGithubProxyRoutes(service, upstream);
    const response = await app.request(
      `${CLOUD_GITHUB_PROXY_PATH}/api/repos/org/repo/pulls/7/comments/21/replies`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer zgp_${"p".repeat(43)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: "Confirmed" }),
      },
    );
    expect(response.status).toBe(201);
    expect(authorizeProxy).toHaveBeenLastCalledWith(
      `zgp_${"p".repeat(43)}`,
      "api",
    );
    expect(await response.text()).not.toContain("synthetic-user-token");
  });
  it("retains the exact legacy conversation payload", () => {
    expect(githubCommentWriteBody({ body: "Review" })).toEqual({
      body: "Review",
    });
    expect(
      authorizeGithubReviewRequest(
        { ...scope, expectedBody: { body: "Review" } },
        "POST",
        "/repos/org/repo/issues/7/comments",
        { body: "Review" },
      ),
    ).toBeUndefined();
  });
  it("binds line comments to the approved head, side, range, path and body", () => {
    const expectedBody = githubCommentWriteBody(line);
    const target = { ...scope, expectedBody };
    const payload = expectedBody.body as Record<string, unknown>;
    expect(
      authorizeGithubReviewRequest(
        target,
        "POST",
        "/repos/org/repo/pulls/7/comments",
        payload,
      ),
    ).toBe("api");
    expect(githubReviewPreflight(target)).toEqual({
      path: "/repos/org/repo/pulls/7",
    });
    expect(() =>
      assertGithubReviewTarget(target, {
        head: { sha },
        base: { sha: baseSha },
      }),
    ).not.toThrow();
    expect(() =>
      assertGithubReviewTarget(target, {
        head: { sha: "b".repeat(40) },
        base: { sha: baseSha },
      }),
    ).toThrow();
    for (const route of [
      "/repos/org/repo/pulls/8/comments",
      "/repos/org/other/pulls/7/comments",
      "/repos/org/repo/issues/7/comments",
    ]) {
      expect(() =>
        authorizeGithubReviewRequest(target, "POST", route, payload),
      ).toThrow();
    }
    for (const update of [
      { side: "RIGHT" },
      { line: 9 },
      { start_line: 3 },
      { path: "different.ts" },
      { body: "Changed" },
      { commit_id: "b".repeat(40) },
    ]) {
      expect(() =>
        authorizeGithubReviewRequest(
          target,
          "POST",
          "/repos/org/repo/pulls/7/comments",
          { ...payload, ...update },
        ),
      ).toThrow();
    }
  });
  it("validates unsupported variants and malformed anchors before issuing capability bodies", () => {
    for (const fields of [
      { path: "../secret" },
      { path: "/secret" },
      { startLine: 9 },
      { line: 0 },
      { side: "file" },
      { body: " " },
      { commitSha: "main" },
      { kind: "delete" },
    ]) {
      expect(() => githubCommentWriteBody({ ...line, ...fields })).toThrow();
    }
  });
  it("admits only the bound reply and verifies its PR ownership independently", () => {
    const target = {
      ...scope,
      expectedBody: githubCommentWriteBody({
        kind: "reply",
        commentId: 21,
        body: "Confirmed",
      }),
    };
    expect(
      authorizeGithubReviewRequest(
        target,
        "GET",
        "/repos/org/repo/pulls/comments/21",
        undefined,
      ),
    ).toBeNull();
    expect(
      authorizeGithubReviewRequest(
        target,
        "POST",
        "/repos/org/repo/pulls/7/comments/21/replies",
        { body: "Confirmed" },
      ),
    ).toBe("api");
    expect(() =>
      authorizeGithubReviewRequest(
        target,
        "POST",
        "/repos/org/repo/pulls/7/comments/22/replies",
        { body: "Confirmed" },
      ),
    ).toThrow();
    expect(() =>
      assertGithubReviewTarget(target, {
        pull_request_url: "https://api.github.com/repos/org/repo/pulls/7",
      }),
    ).not.toThrow();
    expect(() =>
      assertGithubReviewTarget(target, {
        pull_request_url: "https://api.github.com/repos/org/repo/pulls/8",
      }),
    ).toThrow();
    expect(() =>
      assertGithubReviewTarget(target, {
        pull_request_url: "https://elsewhere.invalid/repos/org/repo/pulls/7",
      }),
    ).toThrow();
  });
  it("permits only the selected resolution, thread and fixed GraphQL operation", () => {
    const target = {
      ...scope,
      expectedBody: githubCommentWriteBody({
        kind: "resolve",
        threadId: "thread-1",
        resolved: true,
      }),
    };
    const query =
      "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }";
    const body = { query, variables: { id: "thread-1" } };
    expect(authorizeGithubReviewRequest(target, "POST", "/graphql", body)).toBe(
      "api",
    );
    const preflight = githubReviewPreflight(target)!;
    expect(
      authorizeGithubReviewRequest(
        target,
        "POST",
        preflight.path,
        preflight.body,
      ),
    ).toBeNull();
    for (const bad of [
      { ...body, variables: { id: "thread-2" } },
      {
        ...body,
        query: query.replace("resolveReviewThread", "unresolveReviewThread"),
      },
      { ...body, query: "query { viewer { login } }" },
      { ...body, additional: "field" },
    ]) {
      expect(() =>
        authorizeGithubReviewRequest(target, "POST", "/graphql", bad),
      ).toThrow();
    }
    const node = {
      id: "thread-1",
      pullRequest: { number: 7, repository: { nameWithOwner: "org/repo" } },
    };
    expect(() =>
      assertGithubReviewTarget(target, { data: { node } }),
    ).not.toThrow();
    expect(() =>
      assertGithubReviewTarget(target, {
        data: {
          node: { ...node, pullRequest: { ...node.pullRequest, number: 8 } },
        },
      }),
    ).toThrow();
    expect(() =>
      assertGithubReviewTarget(target, {
        data: {
          node: {
            ...node,
            pullRequest: {
              ...node.pullRequest,
              repository: { nameWithOwner: "org/other" },
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      assertGithubReviewTarget(target, { data: { node: null } }),
    ).toThrow();
  });
});
