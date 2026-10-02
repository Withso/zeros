import type { Octokit } from "@octokit/rest";
import {
  githubReviewPathSchema,
  githubReviewTargetSchema,
  prLineCommentSchema,
  prThreadReplySchema,
  prThreadResolveSchema,
  type PrCodeAnnotation,
  type PrCommentResult,
  type PrInlineReview,
  type PrLineCommentInput,
  type PrReviewTarget,
  type PrReviewDiff,
  type PrReviewThread,
  type PrThreadReplyInput,
  type PrThreadResolveInput,
} from "@zeros/protocol/github-review";
import { GitError } from "./errors";

interface Dependencies {
  repository(workspaceId: string): Promise<{ owner: string; repo: string }>;
  withAuth<T>(read: (octokit: Octokit) => Promise<T>): Promise<T>;
}
interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}
interface ThreadNode {
  id: string;
  path: string;
  diffSide: "LEFT" | "RIGHT";
  startLine: number | null;
  line: number | null;
  originalStartLine: number | null;
  originalLine: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  comments: {
    pageInfo: PageInfo;
    nodes: Array<{
      id: string;
      databaseId: number | null;
      author: { login: string; avatarUrl: string; __typename: string } | null;
      body: string;
      url: string;
      createdAt: string;
      updatedAt: string;
      originalCommit: { oid: string } | null;
      diffHunk?: string;
    }>;
  };
}
interface ThreadsQuery {
  repository: {
    pullRequest: {
      headRefOid: string;
      baseRefOid: string;
      reviewThreads: { pageInfo: PageInfo; nodes: ThreadNode[] };
    } | null;
  } | null;
}

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid baseRefOid
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id path diffSide startLine line originalStartLine originalLine
          isResolved isOutdated viewerCanResolve viewerCanUnresolve
          comments(first: 50) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id databaseId body url createdAt updatedAt diffHunk
              author { login avatarUrl __typename }
              originalCommit { oid }
            }
          }
        }
      }
    }
  }
}`;

// These fixed operations are also pinned by the cloud GitHub write proxy. The
// proxy verifies that the node belongs to its admitted repository and PR.
export const REVIEW_THREAD_TARGET_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      id pullRequest { number repository { nameWithOwner } }
    }
  }
}`;
export const RESOLVE_REVIEW_THREAD_MUTATION = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;
export const UNRESOLVE_REVIEW_THREAD_MUTATION = `mutation($id: ID!) {
  unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

function validation(message: string): never {
  throw new GitError({ code: "VALIDATION_FAILED", message });
}
function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
function timestamp(value: string): number {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : 0;
}

/** Recover only the selected original lines, not arbitrary neighboring source.
 * Context can verify a Files-tab anchor without trusting a shifted line number. */
export function githubThreadContext(
  node: Pick<
    ThreadNode,
    "diffSide" | "originalStartLine" | "originalLine" | "comments"
  >,
): string | undefined {
  const patch = node.comments.nodes[0]?.diffHunk;
  const end = node.originalLine;
  if (!patch || end === null) return undefined;
  const start = node.originalStartLine ?? end;
  const values: string[] = [];
  let oldLine = 0,
    newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (oldLine === 0 && newLine === 0) continue;
    const kind = line[0];
    if (kind !== " " && kind !== "+" && kind !== "-") continue;
    const included = node.diffSide === "LEFT" ? kind !== "+" : kind !== "-";
    const at = node.diffSide === "LEFT" ? oldLine : newLine;
    if (included && at >= start && at <= end)
      values.push(line.slice(1).replace(/\r$/, ""));
    if (kind !== "+") oldLine++;
    if (kind !== "-") newLine++;
  }
  const context = values.join("\n");
  return values.length === end - start + 1 && context.length <= 8000
    ? context
    : undefined;
}
function threadFromNode(node: ThreadNode): PrReviewThread {
  const context = githubThreadContext(node);
  const thread: PrReviewThread = {
    id: node.id,
    path: node.path,
    side: node.diffSide,
    startLine: node.startLine,
    line: node.line,
    originalStartLine: node.originalStartLine,
    originalLine: node.originalLine,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    canResolve: node.viewerCanResolve,
    canUnresolve: node.viewerCanUnresolve,
    commentsTruncated: node.comments.pageInfo.hasNextPage,
    ...(context !== undefined ? { context } : {}),
    comments: node.comments.nodes.map((comment) => ({
      id: comment.id,
      databaseId: comment.databaseId,
      author: {
        login: comment.author?.login ?? "Deleted account",
        avatarUrl: safeUrl(comment.author?.avatarUrl),
        kind: comment.author?.__typename === "Bot" ? "bot" : "human",
      },
      body: comment.body.slice(0, 60_000),
      url: safeUrl(comment.url),
      createdAt: timestamp(comment.createdAt),
      updatedAt: timestamp(comment.updatedAt),
      commitSha: comment.originalCommit?.oid ?? null,
    })),
  };
  // Keep one unusually long conversation inside the bridge-frame budget. The
  // root remains available for replies; the UI links the complete discussion.
  let bytes = 0;
  const count = thread.comments.findIndex((comment) => {
    bytes += Buffer.byteLength(JSON.stringify(comment), "utf8");
    return bytes > 512 * 1024;
  });
  if (count !== -1) {
    thread.comments = thread.comments.slice(0, Math.max(1, count));
    thread.commentsTruncated = true;
  }
  return thread;
}

/** Bounded aggregate read: one snapshot per PR, never a request per visible
 * file/line. Limits remain explicit so large reviews are not mistaken for empty. */
export function createGithubInlineReviewService(deps: Dependencies) {
  async function repositoryFor(workspaceId: string) {
    // The workspace resolver also owns local metadata such as remote name.
    // Octokit serializes unknown fields, so project the API target explicitly.
    const { owner, repo } = await deps.repository(workspaceId);
    return { owner, repo };
  }
  async function get(input: PrReviewTarget): Promise<PrInlineReview> {
    const opts = githubReviewTargetSchema.parse(input);
    const repository = await repositoryFor(opts.workspaceId);
    const threads: PrReviewThread[] = [];
    let after: string | null = null;
    let headSha: string | null = null;
    let baseSha: string | null = null;
    let threadsTruncated = false;
    let threadBytes = 0;
    let threadBudgetFull = false;
    for (let page = 0; page < 10; page++) {
      const response: ThreadsQuery = await deps.withAuth((oct) =>
        oct.graphql<ThreadsQuery>(THREADS_QUERY, {
          ...repository,
          number: opts.prNumber,
          after,
        }),
      );
      const pr = response.repository?.pullRequest;
      if (!pr) validation("This pull request is no longer available.");
      if (
        headSha !== null &&
        (headSha !== pr.headRefOid || baseSha !== pr.baseRefOid)
      ) {
        validation(
          "The pull request changed while loading comments. Refresh to read its latest revision.",
        );
      }
      headSha = pr.headRefOid;
      baseSha = pr.baseRefOid;
      for (const node of pr.reviewThreads.nodes) {
        if (!githubReviewPathSchema.safeParse(node.path).success) continue;
        const thread = threadFromNode(node);
        const bytes = Buffer.byteLength(JSON.stringify(thread), "utf8");
        if (threadBytes + bytes > 6 * 1024 * 1024) {
          threadBudgetFull = true;
          break;
        }
        threadBytes += bytes;
        threads.push(thread);
      }
      threadsTruncated =
        threadBudgetFull || pr.reviewThreads.pageInfo.hasNextPage;
      if (threadBudgetFull) break;
      if (!threadsTruncated) break;
      const cursor = pr.reviewThreads.pageInfo.endCursor;
      if (!cursor || cursor === after)
        validation(
          "GitHub returned an incomplete review page. Refresh to try again.",
        );
      after = cursor;
    }
    const snapshot: PrInlineReview = {
      headSha: headSha!,
      baseSha: baseSha!,
      threads,
      annotations: [],
      threadsTruncated,
      annotationsTruncated: false,
      annotationError: null,
    };
    try {
      const runs = await deps.withAuth((oct) =>
        oct.checks.listForRef({
          ...repository,
          ref: snapshot.headSha,
          per_page: 100,
          filter: "latest",
        }),
      );
      snapshot.annotationsTruncated =
        runs.data.total_count > runs.data.check_runs.length;
      const annotatedRuns = runs.data.check_runs.filter(
        (run) => run.output.annotations_count > 0,
      );
      if (annotatedRuns.length > 20) snapshot.annotationsTruncated = true;
      let annotationBytes = 0;
      let annotationBudgetFull = false;
      for (const run of annotatedRuns.slice(0, 20)) {
        let count = 0;
        for (
          let page = 1;
          page <= 10 && snapshot.annotations.length < 1000;
          page++
        ) {
          const annotations = await deps.withAuth((oct) =>
            oct.checks.listAnnotations({
              ...repository,
              check_run_id: run.id,
              per_page: 100,
              page,
            }),
          );
          for (const [index, annotation] of annotations.data.entries()) {
            if (snapshot.annotations.length >= 1000) break;
            if (
              !githubReviewPathSchema.safeParse(annotation.path).success ||
              annotation.start_line < 1 ||
              annotation.end_line < annotation.start_line
            )
              continue;
            const level = annotation.annotation_level;
            const finding: PrCodeAnnotation = {
              id: `${run.id}:${(page - 1) * 100 + index}`,
              path: annotation.path,
              startLine: annotation.start_line,
              endLine: annotation.end_line,
              level:
                level === "failure" || level === "warning" ? level : "notice",
              title: (annotation.title ?? "").slice(0, 1024),
              message: (annotation.message ?? "").slice(0, 60_000),
              source: run.name,
              url: safeUrl(run.details_url ?? run.html_url),
              commitSha: snapshot.headSha,
            };
            const bytes = Buffer.byteLength(JSON.stringify(finding), "utf8");
            if (annotationBytes + bytes > 2 * 1024 * 1024) {
              annotationBudgetFull = true;
              break;
            }
            annotationBytes += bytes;
            snapshot.annotations.push(finding);
          }
          count += annotations.data.length;
          if (annotationBudgetFull) break;
          if (
            annotations.data.length < 100 ||
            count >= run.output.annotations_count
          )
            break;
        }
        if (count < run.output.annotations_count)
          snapshot.annotationsTruncated = true;
        if (annotationBudgetFull) {
          snapshot.annotationsTruncated = true;
          break;
        }
      }
    } catch {
      // Preserve partial findings and discussions. Do not turn a denied Checks
      // permission or a network failure into a claim of zero findings.
      snapshot.annotationError =
        "Some check annotations could not be loaded. Refresh to try again.";
    }
    return snapshot;
  }

  async function diff(input: PrReviewTarget): Promise<PrReviewDiff> {
    const opts = githubReviewTargetSchema.parse(input);
    const repository = await repositoryFor(opts.workspaceId);
    const request = { ...repository, pull_number: opts.prNumber };
    const before = await deps.withAuth((oct) => oct.pulls.get(request));
    const response = await deps.withAuth((oct) =>
      oct.pulls.get({ ...request, mediaType: { format: "diff" } }),
    );
    const patch: unknown = response.data;
    if (
      typeof patch !== "string" ||
      Buffer.byteLength(patch, "utf8") > 8 * 1024 * 1024
    ) {
      validation(
        "This pull request diff is too large to display here. Open the pull request on GitHub.",
      );
    }
    const after = await deps.withAuth((oct) => oct.pulls.get(request));
    if (
      before.data.head.sha !== after.data.head.sha ||
      before.data.base.sha !== after.data.base.sha
    )
      validation(
        "The pull request changed while loading its diff. Refresh to try again.",
      );
    return {
      headSha: after.data.head.sha,
      baseSha: after.data.base.sha,
      patch,
    };
  }

  async function post(input: PrLineCommentInput): Promise<PrCommentResult> {
    const opts = prLineCommentSchema.parse(input);
    const repository = await repositoryFor(opts.workspaceId);
    const pr = await deps.withAuth((oct) =>
      oct.pulls.get({
        ...repository,
        pull_number: opts.prNumber,
      }),
    );
    if (
      pr.data.head.sha !== opts.commitSha ||
      pr.data.base.sha !== opts.baseSha
    )
      validation(
        "The pull request changed. Refresh the diff before posting this line comment.",
      );
    const result = await deps.withAuth((oct) =>
      oct.pulls.createReviewComment({
        ...repository,
        pull_number: opts.prNumber,
        body: opts.body,
        path: opts.path,
        commit_id: opts.commitSha,
        line: opts.line,
        side: opts.side,
        ...(opts.startLine !== undefined && opts.startLine < opts.line
          ? { start_line: opts.startLine, start_side: opts.side }
          : {}),
      }),
    );
    return { id: result.data.id, url: result.data.html_url };
  }

  async function reply(input: PrThreadReplyInput): Promise<PrCommentResult> {
    const opts = prThreadReplySchema.parse(input);
    const repository = await repositoryFor(opts.workspaceId);
    const comment = await deps.withAuth((oct) =>
      oct.pulls.getReviewComment({
        ...repository,
        comment_id: opts.commentId,
      }),
    );
    const expected = `https://api.github.com/repos/${repository.owner}/${repository.repo}/pulls/${opts.prNumber}`;
    if (comment.data.pull_request_url.toLowerCase() !== expected.toLowerCase())
      validation("This comment belongs to a different pull request.");
    const result = await deps.withAuth((oct) =>
      oct.pulls.createReplyForReviewComment({
        ...repository,
        pull_number: opts.prNumber,
        comment_id: opts.commentId,
        body: opts.body,
      }),
    );
    return { id: result.data.id, url: result.data.html_url };
  }

  async function setResolved(input: PrThreadResolveInput): Promise<void> {
    const opts = prThreadResolveSchema.parse(input);
    const repository = await repositoryFor(opts.workspaceId);
    const target = await deps.withAuth((oct) =>
      oct.graphql<{
        node: {
          id: string;
          pullRequest: {
            number: number;
            repository: { nameWithOwner: string };
          };
        } | null;
      }>(REVIEW_THREAD_TARGET_QUERY, { id: opts.threadId }),
    );
    if (
      !target.node ||
      target.node.id !== opts.threadId ||
      target.node.pullRequest?.number !== opts.prNumber ||
      target.node.pullRequest.repository.nameWithOwner.toLowerCase() !==
        `${repository.owner}/${repository.repo}`.toLowerCase()
    ) {
      validation("This review thread does not belong to this pull request.");
    }
    await deps.withAuth((oct) =>
      oct.graphql(
        opts.resolved
          ? RESOLVE_REVIEW_THREAD_MUTATION
          : UNRESOLVE_REVIEW_THREAD_MUTATION,
        { id: opts.threadId },
      ),
    );
  }
  return { get, diff, post, reply, setResolved };
}
