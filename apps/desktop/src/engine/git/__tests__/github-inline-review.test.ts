import { describe, expect, it, vi } from "vitest";
import { Octokit } from "@octokit/rest";
import {
  createGithubInlineReviewService,
  githubThreadContext,
} from "../github-inline-review";

const target = { workspaceId: "workspace-a", prNumber: 7 };
const sha = "a".repeat(40);
const baseSha = "b".repeat(40);
const pageInfo = { hasNextPage: false, endCursor: null };
function thread(id = "thread-1") {
  return {
    id,
    path: "src/auth.ts",
    diffSide: "LEFT" as const,
    startLine: 4,
    line: 6 as number | null,
    originalStartLine: 8,
    originalLine: 10,
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    comments: {
      pageInfo,
      nodes: [
        {
          id: "comment-1",
          databaseId: 21,
          body: "Check the role.",
          author: {
            login: "review-bot",
            avatarUrl: "https://avatars.githubusercontent.com/u/1",
            __typename: "Bot",
          },
          url: "https://github.com/org/repo/pull/7#discussion_r21",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
          originalCommit: { oid: sha },
        },
      ],
    },
  };
}
function page(nodes = [thread()], after: string | null = null, head = sha) {
  return {
    repository: {
      pullRequest: {
        headRefOid: head,
        baseRefOid: baseSha,
        reviewThreads: {
          nodes,
          pageInfo: { hasNextPage: after !== null, endCursor: after },
        },
      },
    },
  };
}
function setup() {
  const graphql = vi.fn().mockResolvedValue(page());
  const listForRef = vi
    .fn()
    .mockResolvedValue({ data: { total_count: 0, check_runs: [] } });
  const listAnnotations = vi.fn().mockResolvedValue({ data: [] });
  const get = vi
    .fn()
    .mockResolvedValue({ data: { head: { sha }, base: { sha: baseSha } } });
  const createReviewComment = vi
    .fn()
    .mockResolvedValue({
      data: {
        id: 23,
        html_url: "https://github.com/org/repo/pull/7#discussion_r23",
      },
    });
  const getReviewComment = vi
    .fn()
    .mockResolvedValue({
      data: {
        pull_request_url: "https://api.github.com/repos/org/repo/pulls/7",
      },
    });
  const createReplyForReviewComment = vi
    .fn()
    .mockResolvedValue({
      data: {
        id: 24,
        html_url: "https://github.com/org/repo/pull/7#discussion_r24",
      },
    });
  const client = {
    graphql,
    checks: { listForRef, listAnnotations },
    pulls: {
      get,
      createReviewComment,
      getReviewComment,
      createReplyForReviewComment,
    },
  } as unknown as Octokit;
  const repository = vi.fn(async () => ({
    owner: "org",
    repo: "repo",
    remote: "origin",
  }));
  const service = createGithubInlineReviewService({
    repository,
    withAuth: async (read) => read(client),
  });
  return {
    service,
    repository,
    graphql,
    listForRef,
    listAnnotations,
    get,
    createReviewComment,
    getReviewComment,
    createReplyForReviewComment,
  };
}

describe("GitHub inline review aggregate", () => {
  it("rejects a published diff whose base changes while its head stays the same", async () => {
    const { service, get } = setup();
    get
      .mockResolvedValueOnce({
        data: { head: { sha }, base: { sha: baseSha } },
      })
      .mockResolvedValueOnce({ data: "diff --git a/source.ts b/source.ts\n" })
      .mockResolvedValueOnce({
        data: { head: { sha }, base: { sha: "c".repeat(40) } },
      });
    await expect(service.diff(target)).rejects.toThrow(
      "changed while loading its diff",
    );
  });
  it("rejects mixed-base thread pages even if the head stays the same", async () => {
    const { service, graphql } = setup();
    const changed = page([thread("thread-2")]);
    changed.repository.pullRequest.baseRefOid = "c".repeat(40);
    graphql
      .mockResolvedValueOnce(page([thread()], "next"))
      .mockResolvedValueOnce(changed);
    await expect(service.get(target)).rejects.toThrow("changed while loading");
  });
  it("recovers original source context on the correct side only", () => {
    const original = thread();
    const withHunk = {
      ...original,
      diffSide: "LEFT" as const,
      originalStartLine: 8,
      originalLine: 9,
      comments: {
        ...original.comments,
        nodes: [
          {
            ...original.comments.nodes[0],
            diffHunk: "@@ -8,3 +8,3 @@\n-old role\n+new role\n context\n tail",
          },
        ],
      },
    };
    expect(githubThreadContext(withHunk)).toBe("old role\ncontext");
    expect(githubThreadContext({ ...withHunk, diffSide: "RIGHT" })).toBe(
      "new role\ncontext",
    );
    expect(
      githubThreadContext({ ...withHunk, originalLine: 99 }),
    ).toBeUndefined();
  });
  it("loads a published PR diff and rejects a head change during the read", async () => {
    const { service, get } = setup();
    get
      .mockResolvedValueOnce({
        data: { head: { sha }, base: { sha: baseSha } },
      })
      .mockResolvedValueOnce({ data: "diff --git a/source.ts b/source.ts\n" })
      .mockResolvedValueOnce({
        data: { head: { sha }, base: { sha: baseSha } },
      });
    expect(await service.diff(target)).toEqual({
      headSha: sha,
      baseSha,
      patch: "diff --git a/source.ts b/source.ts\n",
    });
    get
      .mockResolvedValueOnce({
        data: { head: { sha }, base: { sha: baseSha } },
      })
      .mockResolvedValueOnce({ data: "diff --git a/source.ts b/source.ts\n" })
      .mockResolvedValueOnce({
        data: { head: { sha: "b".repeat(40) }, base: { sha: baseSha } },
      });
    await expect(service.diff(target)).rejects.toThrow(
      "changed while loading its diff",
    );
  });
  it("keeps bot authors, old-side ranges, replies and original revisions", async () => {
    const { service, repository } = setup();
    const result = await service.get(target);
    expect(repository).toHaveBeenCalledWith("workspace-a");
    expect(result).toMatchObject({
      headSha: sha,
      threadsTruncated: false,
      annotationError: null,
    });
    expect(result.threads[0]).toMatchObject({
      path: "src/auth.ts",
      side: "LEFT",
      startLine: 4,
      line: 6,
      originalLine: 10,
      canResolve: true,
      comments: [
        { author: { kind: "bot", login: "review-bot" }, commitSha: sha },
      ],
    });
  });
  it("reads subsequent thread pages and refuses a mixed-head snapshot", async () => {
    const { service, graphql } = setup();
    graphql
      .mockResolvedValueOnce(page([thread()], "next"))
      .mockResolvedValueOnce(page([thread("thread-2")]));
    expect((await service.get(target)).threads.map((row) => row.id)).toEqual([
      "thread-1",
      "thread-2",
    ]);
    expect(graphql.mock.calls[1][1]).toMatchObject({
      after: "next",
      owner: "org",
      repo: "repo",
      number: 7,
    });
    graphql
      .mockResolvedValueOnce(page([thread()], "next"))
      .mockResolvedValueOnce(page([], null, "b".repeat(40)));
    await expect(service.get(target)).rejects.toThrow("changed while loading");
  });
  it("reports partial discussions explicitly at bounded pagination limits", async () => {
    const { service, graphql } = setup();
    graphql.mockImplementation(async (_query, vars) =>
      page([thread()], `${vars.after ?? ""}a`),
    );
    const result = await service.get(target);
    expect(result.threadsTruncated).toBe(true);
    expect(graphql).toHaveBeenCalledTimes(10);
  });
  it("loads check annotations at the same head and preserves discussions on a check failure", async () => {
    const { service, listForRef, listAnnotations } = setup();
    listForRef.mockResolvedValue({
      data: {
        total_count: 1,
        check_runs: [
          {
            id: 12,
            name: "Code scanning",
            output: { annotations_count: 1 },
            details_url: "https://github.com/org/repo/runs/12",
          },
        ],
      },
    });
    listAnnotations.mockResolvedValue({
      data: [
        {
          path: "src/auth.ts",
          start_line: 4,
          end_line: 5,
          annotation_level: "warning",
          title: "Validation",
          message: "Validate role.",
        },
      ],
    });
    const result = await service.get(target);
    expect(listForRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: sha }),
    );
    expect(result.annotations[0]).toMatchObject({
      id: "12:0",
      startLine: 4,
      endLine: 5,
      commitSha: sha,
      level: "warning",
    });
    listAnnotations.mockRejectedValue(new Error("Missing permission"));
    const partial = await service.get(target);
    expect(partial.threads).toHaveLength(1);
    expect(partial.annotationError).toContain("could not be loaded");
  });
  it("retains outdated and resolved discussions, but rejects unsafe paths and URLs", async () => {
    const { service, graphql } = setup();
    const old = { ...thread(), isOutdated: true, isResolved: true, line: null };
    old.comments.nodes[0].url = "javascript:alert(1)";
    graphql.mockResolvedValue(
      page([old, { ...thread("unsafe"), path: "../secret" }]),
    );
    const result = await service.get(target);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({
      isOutdated: true,
      isResolved: true,
      line: null,
    });
    expect(result.threads[0].comments[0].url).toBeNull();
  });
});

describe("GitHub inline comment writes", () => {
  it("projects repository metadata before Octokit serializes exact cloud routes and bodies", async () => {
    const { service, get, createReviewComment, createReplyForReviewComment } =
      setup();
    const octokit = new Octokit();
    await service.post({
      ...target,
      body: "Review",
      path: "src/auth.ts",
      side: "RIGHT",
      line: 8,
      commitSha: sha,
      baseSha,
    });
    expect(octokit.pulls.get.endpoint(get.mock.calls[0][0]).url).toBe(
      "https://api.github.com/repos/org/repo/pulls/7",
    );
    const request = octokit.pulls.createReviewComment.endpoint(
      createReviewComment.mock.calls[0][0],
    );
    expect(request.body).toEqual({
      body: "Review",
      path: "src/auth.ts",
      side: "RIGHT",
      line: 8,
      commit_id: sha,
    });
    await service.reply({ ...target, commentId: 21, body: "Reply" });
    const reply = octokit.pulls.createReplyForReviewComment.endpoint(
      createReplyForReviewComment.mock.calls[0][0],
    );
    expect(reply.url).toBe(
      "https://api.github.com/repos/org/repo/pulls/7/comments/21/replies",
    );
    expect(reply.body).toEqual({ body: "Reply" });
  });
  it("refuses an old-side comment when the PR base changed without a new head", async () => {
    const { service, get, createReviewComment } = setup();
    get.mockResolvedValue({
      data: { head: { sha }, base: { sha: "c".repeat(40) } },
    });
    const input = {
      ...target,
      body: "Review",
      path: "src/auth.ts",
      side: "LEFT" as const,
      line: 8,
      commitSha: sha,
      baseSha,
    };
    await expect(service.post(input)).rejects.toThrow("Refresh the diff");
    expect(createReviewComment).not.toHaveBeenCalled();
  });
  it("posts an exact multi-line old-side anchor and refuses stale PR heads", async () => {
    const { service, get, createReviewComment } = setup();
    const input = {
      ...target,
      body: "Review these lines.",
      path: "src/auth.ts",
      side: "LEFT" as const,
      line: 8,
      startLine: 4,
      commitSha: sha,
      baseSha,
    };
    await service.post(input);
    expect(createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        commit_id: sha,
        line: 8,
        side: "LEFT",
        start_line: 4,
        start_side: "LEFT",
      }),
    );
    createReviewComment.mockClear();
    get.mockResolvedValue({
      data: { head: { sha: "b".repeat(40) }, base: { sha: baseSha } },
    });
    await expect(service.post(input)).rejects.toThrow("Refresh the diff");
    expect(createReviewComment).not.toHaveBeenCalled();
  });
  it("validates paths, ranges and bodies before resolving a repository", async () => {
    const { service, repository } = setup();
    const input = {
      ...target,
      body: "Comment",
      path: "src/auth.ts",
      side: "RIGHT" as const,
      line: 8,
      commitSha: sha,
      baseSha,
    };
    for (const changed of [
      { path: "../secret" },
      { path: "/etc/passwd" },
      { path: "C:\\file" },
      { line: 0 },
      { startLine: 9 },
      { body: "   " },
      { body: "a".repeat(60_001) },
    ]) {
      await expect(service.post({ ...input, ...changed })).rejects.toThrow();
    }
    expect(repository).not.toHaveBeenCalled();
  });
  it("replies only to a comment in the selected PR", async () => {
    const { service, getReviewComment, createReplyForReviewComment } = setup();
    await service.reply({ ...target, commentId: 21, body: "Confirmed." });
    expect(createReplyForReviewComment).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      pull_number: 7,
      comment_id: 21,
      body: "Confirmed.",
    });
    getReviewComment.mockResolvedValue({
      data: {
        pull_request_url: "https://api.github.com/repos/org/repo/pulls/9",
      },
    });
    await expect(
      service.reply({ ...target, commentId: 22, body: "Wrong PR." }),
    ).rejects.toThrow("different pull request");
    expect(createReplyForReviewComment).toHaveBeenCalledTimes(1);
  });
  it("verifies thread ownership for resolve and reopen, without arbitrary GraphQL", async () => {
    const { service, graphql } = setup();
    graphql.mockResolvedValue({
      node: {
        id: "thread-1",
        pullRequest: { number: 7, repository: { nameWithOwner: "org/repo" } },
      },
    });
    await service.setResolved({
      ...target,
      threadId: "thread-1",
      resolved: true,
    });
    expect(graphql.mock.calls[1][0]).toContain("resolveReviewThread(input:");
    await service.setResolved({
      ...target,
      threadId: "thread-1",
      resolved: false,
    });
    expect(graphql.mock.calls[3][0]).toContain("unresolveReviewThread(input:");
    graphql.mockClear();
    graphql.mockResolvedValue({
      node: {
        id: "thread-1",
        pullRequest: { number: 8, repository: { nameWithOwner: "org/repo" } },
      },
    });
    await expect(
      service.setResolved({ ...target, threadId: "thread-1", resolved: true }),
    ).rejects.toThrow("does not belong");
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});
