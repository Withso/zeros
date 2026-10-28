import { z } from "zod";
import { HttpError } from "../authz.js";
import { CloudGithubApi, type CloudGithubPrTarget } from "./github-api.js";
import { githubDate, githubId, githubSha } from "./github-http.js";

const nodeId = z.string().min(1).max(256),
  line = z.number().int().positive().max(2_147_483_647);
const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().max(1024).nullable(),
});
const commentSchema = z.object({
  id: nodeId,
  databaseId: githubId.nullable(),
  body: z.string().max(100_000),
  url: z.string(),
  author: z
    .object({
      login: z.string().max(100),
      avatarUrl: z.string(),
      __typename: z.string().max(100),
    })
    .nullable(),
  createdAt: githubDate,
  updatedAt: githubDate,
  originalCommit: z.object({ oid: githubSha }).nullable(),
  diffHunk: z.string().max(100_000).optional(),
});
const threadSchema = z.object({
  id: nodeId,
  path: z.string().max(4096),
  diffSide: z.enum(["LEFT", "RIGHT"]),
  startLine: line.nullable(),
  line: line.nullable(),
  originalStartLine: line.nullable(),
  originalLine: line.nullable(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  viewerCanResolve: z.boolean(),
  viewerCanUnresolve: z.boolean(),
  comments: z.object({ pageInfo, nodes: z.array(commentSchema).max(50) }),
});
type Thread = z.infer<typeof threadSchema>;
const threadPageSchema = z.object({
  data: z.object({
    node: z
      .object({
        id: nodeId,
        headRefOid: githubSha,
        baseRefOid: githubSha,
        reviewThreads: z.object({
          pageInfo,
          nodes: z.array(threadSchema).max(50),
        }),
      })
      .nullable(),
  }),
});
const threadsQuery = `query($id:ID!,$after:String) {
  node(id:$id) { ... on PullRequest { id headRefOid baseRefOid
    reviewThreads(first:50,after:$after) { pageInfo { hasNextPage endCursor } nodes {
      id path diffSide startLine line originalStartLine originalLine isResolved isOutdated viewerCanResolve viewerCanUnresolve
      comments(first:50) { pageInfo { hasNextPage endCursor } nodes { id databaseId body url createdAt updatedAt diffHunk
        author { login avatarUrl __typename } originalCommit { oid } } }
    } }
  } }
}`;
const changed = () =>
  new HttpError(
    409,
    "github_pr_changed",
    "The pull request changed. Refresh its review before continuing.",
  );
const identityChanged = () =>
  new HttpError(
    409,
    "github_pr_identity_changed",
    "This discussion belongs to a different pull request.",
  );
const safePath = (value: string) =>
  value.length > 0 &&
  !/^[\\/]|^[A-Za-z]:|[\0-\x1f\\]/.test(value) &&
  value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
function safeUrl(value: string | null | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
function context(thread: Thread): string | undefined {
  const patch = thread.comments.nodes[0]?.diffHunk,
    end = thread.originalLine;
  if (!patch || end === null) return undefined;
  const start = thread.originalStartLine ?? end,
    lines: string[] = [];
  let left = 0,
    right = 0;
  for (const value of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(value);
    if (header) {
      left = Number(header[1]);
      right = Number(header[2]);
      continue;
    }
    if ((!left && !right) || ![" ", "+", "-"].includes(value[0]!)) continue;
    const included =
        thread.diffSide === "LEFT" ? value[0] !== "+" : value[0] !== "-",
      at = thread.diffSide === "LEFT" ? left : right;
    if (included && at >= start && at <= end)
      lines.push(value.slice(1).replace(/\r$/, ""));
    if (value[0] !== "+") left++;
    if (value[0] !== "-") right++;
  }
  const result = lines.join("\n");
  return lines.length === end - start + 1 && result.length <= 8000
    ? result
    : undefined;
}
function projectThread(thread: Thread) {
  let bytes = 0;
  const comments = thread.comments.nodes
    .map((row) => ({
      id: row.id,
      databaseId: row.databaseId,
      author: {
        login: row.author?.login ?? "Deleted account",
        avatarUrl: safeUrl(row.author?.avatarUrl),
        kind:
          row.author?.__typename === "Bot"
            ? ("bot" as const)
            : ("human" as const),
      },
      body: row.body.slice(0, 60_000),
      url: safeUrl(row.url),
      createdAt: Date.parse(row.createdAt),
      updatedAt: Date.parse(row.updatedAt),
      commitSha: row.originalCommit?.oid ?? null,
    }))
    .filter((row) => {
      bytes += Buffer.byteLength(JSON.stringify(row));
      return bytes <= 256 * 1024;
    });
  const source = context(thread);
  return {
    id: thread.id,
    path: thread.path,
    side: thread.diffSide,
    startLine: thread.startLine,
    line: thread.line,
    originalStartLine: thread.originalStartLine,
    originalLine: thread.originalLine,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    canResolve: thread.viewerCanResolve,
    canUnresolve: thread.viewerCanUnresolve,
    comments,
    commentsTruncated:
      thread.comments.pageInfo.hasNextPage ||
      comments.length !== thread.comments.nodes.length,
    ...(source === undefined ? {} : { context: source }),
  };
}
type Revision = { headSha: string; baseSha: string };
type Annotation = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  level: "notice" | "warning" | "failure";
  title: string;
  message: string;
  source: string;
  url: string | null;
  commitSha: string;
};

/** Published GitHub discussions only. Workspace-private comments have their
 * own persistence and must never be silently posted to GitHub. */
export class CloudGithubReviewApi {
  constructor(private readonly api: CloudGithubApi) {}

  private revision(
    pull: { head: { sha: string }; base: { sha: string } },
    revision: Revision,
  ) {
    if (
      pull.head.sha !== revision.headSha ||
      pull.base.sha !== revision.baseSha
    )
      throw changed();
  }

  async get(target: CloudGithubPrTarget, number: number) {
    const { repo, pull } = await this.api.readPull(target, number);
    const revision = { headSha: pull.head.sha, baseSha: pull.base.sha };
    const threads: ReturnType<typeof projectThread>[] = [];
    let after: string | null = null,
      threadsTruncated = false,
      bytes = 0;
    for (let page = 0; page < 10; page++) {
      const result: z.infer<typeof threadPageSchema> = await this.api.http.json(
        "/graphql",
        threadPageSchema,
        {
          method: "POST",
          body: { query: threadsQuery, variables: { id: pull.node_id, after } },
        },
      );
      const pr = result.data.node;
      if (!pr || pr.id !== pull.node_id) throw identityChanged();
      if (
        pr.headRefOid !== revision.headSha ||
        pr.baseRefOid !== revision.baseSha
      )
        throw changed();
      let full = false;
      for (const node of pr.reviewThreads.nodes) {
        if (!safePath(node.path)) continue;
        const row = projectThread(node);
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (bytes > 1536 * 1024) {
          full = true;
          break;
        }
        threads.push(row);
      }
      threadsTruncated = full || pr.reviewThreads.pageInfo.hasNextPage;
      if (full || !threadsTruncated) break;
      const cursor: string | null = pr.reviewThreads.pageInfo.endCursor;
      if (!cursor || cursor === after)
        throw new HttpError(
          503,
          "github_invalid_response",
          "GitHub returned an incomplete review page.",
        );
      after = cursor;
    }
    const snapshot = {
      ...revision,
      threads,
      threadsTruncated,
      annotations: [] as Annotation[],
      annotationsTruncated: false,
      annotationError: null as string | null,
    };
    const path = `/repositories/${repo.repositoryId}`;
    try {
      const runs = await this.api.http.json(
        `${path}/commits/${revision.headSha}/check-runs?filter=latest&per_page=100`,
        z.object({
          total_count: z.number().int().nonnegative(),
          check_runs: z
            .array(
              z.object({
                id: githubId,
                name: z.string().max(512),
                details_url: z.string().nullable().optional(),
                html_url: z.string().nullable().optional(),
                output: z.object({
                  annotations_count: z.number().int().nonnegative(),
                }),
              }),
            )
            .max(100),
        }),
      );
      const annotated = runs.check_runs.filter(
        (run) => run.output.annotations_count > 0,
      );
      snapshot.annotationsTruncated =
        runs.total_count > runs.check_runs.length || annotated.length > 20;
      let annotationBytes = 0;
      for (const run of annotated.slice(0, 20)) {
        let count = 0;
        for (
          let page = 1;
          page <= 10 &&
          snapshot.annotations.length < 1000 &&
          annotationBytes <= 512 * 1024;
          page++
        ) {
          const rows = await this.api.http.json(
            `${path}/check-runs/${run.id}/annotations?per_page=100&page=${page}`,
            z
              .array(
                z.object({
                  path: z.string().max(4096),
                  start_line: line,
                  end_line: line,
                  annotation_level: z.enum(["notice", "warning", "failure"]),
                  title: z.string().nullable(),
                  message: z.string().max(100_000),
                }),
              )
              .max(100),
          );
          count += rows.length;
          for (const [index, row] of rows.entries()) {
            if (!safePath(row.path) || row.end_line < row.start_line) continue;
            const annotation: Annotation = {
              id: `${run.id}:${(page - 1) * 100 + index}`,
              path: row.path,
              startLine: row.start_line,
              endLine: row.end_line,
              level: row.annotation_level,
              title: (row.title ?? "").slice(0, 1024),
              message: row.message.slice(0, 60_000),
              source: run.name,
              url: safeUrl(run.details_url ?? run.html_url),
              commitSha: revision.headSha,
            };
            annotationBytes += Buffer.byteLength(JSON.stringify(annotation));
            if (
              snapshot.annotations.length >= 1000 ||
              annotationBytes > 512 * 1024
            ) {
              snapshot.annotationsTruncated = true;
              break;
            }
            snapshot.annotations.push(annotation);
          }
          if (rows.length < 100 || count >= run.output.annotations_count) break;
        }
        if (count < run.output.annotations_count)
          snapshot.annotationsTruncated = true;
      }
    } catch (error) {
      // Revocation retires the whole result; a missing Checks scope does not
      // erase otherwise authorized review discussions.
      if (
        error instanceof HttpError &&
        [
          "github_authorization_changed",
          "github_authorization_expired",
        ].includes(error.code)
      )
        throw error;
      snapshot.annotationError =
        "Some check annotations could not be loaded. Refresh to try again.";
    }
    this.revision(
      (await this.api.readPull(target, number, repo)).pull,
      revision,
    );
    return snapshot;
  }

  async reply(
    target: CloudGithubPrTarget,
    number: number,
    input: Revision & { commentId: number; body: string },
  ) {
    const { repo, pull } = await this.api.readPull(target, number);
    this.revision(pull, input);
    const path = `/repositories/${repo.repositoryId}`;
    const comment = await this.api.http.json(
      `${path}/pulls/comments/${input.commentId}`,
      z.object({ pull_request_url: z.string() }),
    );
    // GitHub's response URL is canonical even when the request uses its ID.
    const canonicalPath = `/repos/${repo.repository.split("/").map(encodeURIComponent).join("/")}`;
    if (
      comment.pull_request_url.toLowerCase() !==
      `https://api.github.com${canonicalPath}/pulls/${number}`.toLowerCase()
    )
      throw identityChanged();
    this.revision((await this.api.readPull(target, number, repo)).pull, input);
    const posted = await this.api.http.json(
      `${path}/pulls/${number}/comments/${input.commentId}/replies`,
      z.object({ id: githubId, html_url: z.string().url() }),
      { method: "POST", body: { body: input.body } },
    );
    return { id: posted.id, url: posted.html_url };
  }

  async resolve(
    target: CloudGithubPrTarget,
    number: number,
    input: Revision & { threadId: string; resolved: boolean },
  ) {
    const { repo, pull } = await this.api.readPull(target, number);
    this.revision(pull, input);
    const result = await this.api.http.json(
      "/graphql",
      z.object({
        data: z.object({
          node: z
            .object({
              id: nodeId,
              viewerCanResolve: z.boolean(),
              viewerCanUnresolve: z.boolean(),
              pullRequest: z.object({
                number: githubId,
                headRefOid: githubSha,
                baseRefOid: githubSha,
                repository: z.object({ databaseId: githubId }),
              }),
            })
            .nullable(),
        }),
      }),
      {
        method: "POST",
        body: {
          query:
            "query($id:ID!) { node(id:$id) { ... on PullRequestReviewThread { id viewerCanResolve viewerCanUnresolve pullRequest { number headRefOid baseRefOid repository { databaseId } } } } }",
          variables: { id: input.threadId },
        },
      },
    );
    const node = result.data.node;
    if (
      !node ||
      node.id !== input.threadId ||
      node.pullRequest.number !== number ||
      String(node.pullRequest.repository.databaseId) !== repo.repositoryId
    )
      throw identityChanged();
    if (
      node.pullRequest.headRefOid !== input.headSha ||
      node.pullRequest.baseRefOid !== input.baseSha
    )
      throw changed();
    if (!(input.resolved ? node.viewerCanResolve : node.viewerCanUnresolve))
      throw new HttpError(
        403,
        "github_cloud_write_denied",
        "Your selected GitHub connection cannot change this discussion.",
      );
    const operation = input.resolved
      ? "resolveReviewThread"
      : "unresolveReviewThread";
    const response = await this.api.http.request("/graphql", {
      method: "POST",
      mutation: true,
      body: {
        query: `mutation($id:ID!) { ${operation}(input:{threadId:$id}) { thread { id isResolved } } }`,
        variables: { id: input.threadId },
      },
    });
    const schema = z.object({
      data: z.object({
        [operation]: z.object({
          thread: z.object({
            id: z.literal(input.threadId),
            isResolved: z.literal(input.resolved),
          }),
        }),
      }),
    });
    if (!schema.safeParse(response).success)
      throw new HttpError(
        403,
        "github_cloud_write_denied",
        "GitHub did not confirm the discussion change.",
      );
    return { resolved: input.resolved };
  }
}
