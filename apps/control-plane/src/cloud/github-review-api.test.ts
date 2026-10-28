import { describe, expect, it, vi } from "vitest";
import { CloudGithubApi } from "./github-api.js";
import { CloudGithubReviewApi } from "./github-review-api.js";

const head = "a".repeat(40),
  base = "b".repeat(40);
const repository = {
  id: 42,
  name: "project",
  owner: { login: "example" },
  default_branch: "main",
  private: true,
  archived: false,
  permissions: { push: true },
};
const target = {
  repositoryId: "42",
  repository: "example/project",
  branch: "work",
  baseBranch: "main",
};
const pull = {
  number: 7,
  node_id: "PR_7",
  html_url: "https://github.com/example/project/pull/7",
  state: "open",
  draft: false,
  title: "Change",
  body: null,
  user: { login: "author" },
  base: { sha: base, ref: "main", repo: repository },
  head: { sha: head, ref: "work", repo: repository },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const pageInfo = { hasNextPage: false, endCursor: null };
const thread = {
  id: "PRRT_1",
  path: "src/file.ts",
  diffSide: "RIGHT",
  line: 2,
  startLine: null,
  originalLine: 2,
  originalStartLine: null,
  isResolved: false,
  isOutdated: false,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  comments: {
    pageInfo,
    nodes: [
      {
        id: "PRRC_1",
        databaseId: 10,
        author: {
          login: "review-bot",
          avatarUrl: "https://avatars.githubusercontent.com/1",
          __typename: "Bot",
        },
        body: "A finding",
        url: "https://github.com/example/project/pull/7#discussion_r10",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        originalCommit: { oid: head },
        diffHunk: "@@ -1,2 +1,2 @@\n first\n-second\n+updated",
      },
    ],
  },
};

function fixture(
  extra: (path: string, body: Record<string, unknown>) => Response | undefined,
) {
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const custom = extra(
        path,
        init?.body ? JSON.parse(String(init.body)) : {},
      );
      if (custom) return custom;
      if (path === "/repositories/42") return Response.json(repository);
      if (path === "/repositories/42/pulls/7") return Response.json(pull);
      if (path === "/graphql")
        return Response.json({
          data: {
            node: {
              id: pull.node_id,
              headRefOid: head,
              baseRefOid: base,
              reviewThreads: { pageInfo, nodes: [thread] },
            },
          },
        });
      if (path.endsWith("/check-runs"))
        return Response.json({ total_count: 0, check_runs: [] });
      throw new Error(`Unexpected synthetic path ${path}`);
    },
  );
  const api = new CloudGithubApi({
    apiBaseUrl: "https://api.github.com",
    token: "synthetic-token",
    fetch,
    assertCurrent: async () => {},
  });
  return { api: new CloudGithubReviewApi(api), fetch };
}

describe("cloud published review", () => {
  it("binds paginated review discussions to the immutable pull request node", async () => {
    const { api, fetch } = fixture(() => undefined);
    await api.get(target, 7);
    const call = fetch.mock.calls.find(([url]) =>
      String(url).endsWith("/graphql"),
    );
    expect(JSON.parse(String(call?.[1]?.body)).variables).toEqual({
      id: "PR_7",
      after: null,
    });
  });
  it("rejects another pull request node even when its revisions match", async () => {
    const { api } = fixture((path) =>
      path === "/graphql"
        ? Response.json({
            data: {
              node: {
                id: "PR_99",
                headRefOid: head,
                baseRefOid: base,
                reviewThreads: { pageInfo, nodes: [thread] },
              },
            },
          })
        : undefined,
    );
    await expect(api.get(target, 7)).rejects.toMatchObject({
      code: "github_pr_identity_changed",
    });
  });
  it("preserves bot attribution, source context and discussions when Checks access is denied", async () => {
    const { api } = fixture((path) =>
      path.endsWith("/check-runs")
        ? new Response(null, { status: 403 })
        : undefined,
    );
    const result = await api.get(target, 7);
    expect(result).toMatchObject({
      headSha: head,
      baseSha: base,
      annotations: [],
      annotationError: expect.any(String),
      threads: [
        {
          path: "src/file.ts",
          context: "updated",
          comments: [{ author: { login: "review-bot", kind: "bot" } }],
        },
      ],
    });
  });
  it("rejects pages from different revisions", async () => {
    const { api } = fixture((path) =>
      path === "/graphql"
        ? Response.json({
            data: {
              node: {
                id: pull.node_id,
                headRefOid: "c".repeat(40),
                baseRefOid: base,
                reviewThreads: { pageInfo, nodes: [thread] },
              },
            },
          })
        : undefined,
    );
    await expect(api.get(target, 7)).rejects.toMatchObject({
      code: "github_pr_changed",
    });
  });
  it("refuses replies to comments from another PR without posting", async () => {
    const { api, fetch } = fixture((path) =>
      path.endsWith("/comments/10")
        ? Response.json({
            pull_request_url:
              "https://api.github.com/repos/example/project/pulls/99",
          })
        : undefined,
    );
    await expect(
      api.reply(target, 7, {
        commentId: 10,
        body: "Reply",
        headSha: head,
        baseSha: base,
      }),
    ).rejects.toMatchObject({ code: "github_pr_identity_changed" });
    expect(
      fetch.mock.calls.some(([url]) => String(url).endsWith("/replies")),
    ).toBe(false);
  });
  it("posts a reply by repository ID after validating GitHub's canonical comment URL", async () => {
    const { api, fetch } = fixture((path) => {
      if (path.endsWith("/comments/10"))
        return Response.json({
          pull_request_url:
            "https://api.github.com/repos/example/project/pulls/7",
        });
      if (path.endsWith("/replies"))
        return Response.json({
          id: 11,
          html_url: "https://github.com/example/project/pull/7#discussion_r11",
        });
      return undefined;
    });
    await expect(
      api.reply(target, 7, {
        commentId: 10,
        body: "Reply",
        headSha: head,
        baseSha: base,
      }),
    ).resolves.toMatchObject({ id: 11 });
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(
      "https://api.github.com/repositories/42/pulls/7/comments/10/replies",
    );
  });
  it("validates a thread's repository and revision before resolve", async () => {
    const { api, fetch } = fixture((path) =>
      path === "/graphql"
        ? Response.json({
            data: {
              node: {
                id: "PRRT_1",
                viewerCanResolve: true,
                viewerCanUnresolve: false,
                pullRequest: {
                  number: 7,
                  headRefOid: head,
                  baseRefOid: base,
                  repository: { databaseId: 99 },
                },
              },
            },
          })
        : undefined,
    );
    await expect(
      api.resolve(target, 7, {
        threadId: "PRRT_1",
        resolved: true,
        headSha: head,
        baseSha: base,
      }),
    ).rejects.toMatchObject({ code: "github_pr_identity_changed" });
    expect(
      fetch.mock.calls.filter(([, init]) =>
        String(init?.body).includes("mutation"),
      ),
    ).toHaveLength(0);
  });
  it("does not post a stale reply after the base branch advances", async () => {
    const { api, fetch } = fixture(() => undefined);
    await expect(
      api.reply(target, 7, {
        commentId: 10,
        body: "Reply",
        headSha: head,
        baseSha: "c".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "github_pr_changed" });
    expect(fetch.mock.calls).toHaveLength(2);
  });
});
