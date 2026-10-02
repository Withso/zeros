import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { GithubProxyAuthority } from "./github-write-grants.js";

const commentBody = z
  .string()
  .max(60_000)
  .refine((value) => value.trim().length > 0 && !value.includes("\0"));
const line = z.number().int().positive().max(2_147_483_647);
const side = z.enum(["LEFT", "RIGHT"]);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/^[\\/]|^[A-Za-z]:|[\0-\x1f\\]/.test(value) &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
  );
const nodeId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_+/=-]+$/);
const denied = () => new Error("GitHub review request is not authorized");

/** Compatibility extension of gh.prComment: an absent kind remains a PR
 * conversation comment. Every inline action is explicit and body-bound. */
export function githubCommentWriteBody(
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (params.kind === undefined)
    return { body: z.string().min(1).max(131072).parse(params.body) };
  if (params.kind === "line") {
    const end = line.parse(params.line);
    const start =
      params.startLine === undefined ? end : line.parse(params.startLine);
    if (start > end) throw denied();
    const diffSide = side.parse(params.side);
    return {
      reviewKind: "line",
      baseSha: z
        .string()
        .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
        .parse(params.baseSha),
      body: {
        body: commentBody.parse(params.body),
        path: path.parse(params.path),
        commit_id: z
          .string()
          .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
          .parse(params.commitSha),
        line: end,
        side: diffSide,
        ...(start < end ? { start_line: start, start_side: diffSide } : {}),
      },
    };
  }
  if (params.kind === "reply")
    return {
      reviewKind: "reply",
      commentId: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .parse(params.commentId),
      body: { body: commentBody.parse(params.body) },
    };
  if (params.kind === "resolve")
    return {
      reviewKind: "resolve",
      threadId: nodeId.parse(params.threadId),
      resolved: z.boolean().parse(params.resolved),
    };
  throw denied();
}

// Fixed wire operations, mirrored in the engine's github-inline-review.ts.
const targetQuery =
  "query($id:ID!){node(id:$id){...onPullRequestReviewThread{idpullRequest{numberrepository{nameWithOwner}}}}}";
const resolveQuery =
  "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{idisResolved}}}";
const unresolveQuery =
  "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{idisResolved}}}";
const targetQueryWire = `query($id: ID!) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      id pullRequest { number repository { nameWithOwner } }
    }
  }
}`;

function inline(scope: GithubProxyAuthority): Record<string, unknown> | null {
  return scope.operation === "gh.prComment" && scope.expectedBody?.reviewKind
    ? scope.expectedBody
    : null;
}
/** Optional read owned by the proxy, never a caller-chosen URL/query. This
 * independently checks node/comment ownership even if a worker is compromised. */
export function githubReviewPreflight(
  scope: GithubProxyAuthority,
): { path: string; body?: object } | null {
  const expected = inline(scope);
  if (!expected) return null;
  const repo = `/repos/${scope.owner}/${scope.repository}`;
  if (expected.reviewKind === "line")
    return { path: `${repo}/pulls/${scope.prNumber}` };
  if (expected.reviewKind === "reply")
    return { path: `${repo}/pulls/comments/${expected.commentId}` };
  if (expected.reviewKind === "resolve")
    return {
      path: "/graphql",
      body: { query: targetQueryWire, variables: { id: expected.threadId } },
    };
  throw denied();
}

export function assertGithubReviewTarget(
  scope: GithubProxyAuthority,
  response: unknown,
): void {
  const expected = inline(scope);
  if (!expected) throw denied();
  if (expected.reviewKind === "line") {
    const parsed = z
      .object({
        head: z.object({ sha: z.string() }),
        base: z.object({ sha: z.string() }),
      })
      .safeParse(response);
    if (
      parsed.success &&
      parsed.data.head.sha ===
        (expected.body as Record<string, unknown>).commit_id &&
      parsed.data.base.sha === expected.baseSha
    )
      return;
  } else if (expected.reviewKind === "reply") {
    const parsed = z
      .object({ pull_request_url: z.string() })
      .safeParse(response);
    const target = `https://api.github.com/repos/${scope.owner}/${scope.repository}/pulls/${scope.prNumber}`;
    if (
      parsed.success &&
      parsed.data.pull_request_url.toLowerCase() === target.toLowerCase()
    )
      return;
  } else if (expected.reviewKind === "resolve") {
    const parsed = z
      .object({
        data: z.object({
          node: z.object({
            id: z.string(),
            pullRequest: z.object({
              number: z.number(),
              repository: z.object({ nameWithOwner: z.string() }),
            }),
          }),
        }),
      })
      .safeParse(response);
    if (
      parsed.success &&
      parsed.data.data.node.id === expected.threadId &&
      parsed.data.data.node.pullRequest.number === scope.prNumber &&
      parsed.data.data.node.pullRequest.repository.nameWithOwner.toLowerCase() ===
        `${scope.owner}/${scope.repository}`.toLowerCase()
    )
      return;
  }
  throw denied();
}

/** undefined means this is a legacy operation; null is an authorized read. */
export function authorizeGithubReviewRequest(
  scope: GithubProxyAuthority,
  method: string,
  route: string,
  body: unknown,
): "api" | null | undefined {
  const expected = inline(scope);
  if (!expected) return undefined;
  const repo = `/repos/${scope.owner}/${scope.repository}`;
  if (expected.reviewKind === "line") {
    if (method === "GET" && route === `${repo}/pulls/${scope.prNumber}`)
      return null;
    if (
      method === "POST" &&
      route === `${repo}/pulls/${scope.prNumber}/comments` &&
      isDeepStrictEqual(body, expected.body)
    )
      return "api";
  } else if (expected.reviewKind === "reply") {
    if (
      method === "GET" &&
      route === `${repo}/pulls/comments/${expected.commentId}`
    )
      return null;
    if (
      method === "POST" &&
      route ===
        `${repo}/pulls/${scope.prNumber}/comments/${expected.commentId}/replies` &&
      isDeepStrictEqual(body, expected.body)
    )
      return "api";
  } else if (
    expected.reviewKind === "resolve" &&
    method === "POST" &&
    route === "/graphql"
  ) {
    const parsed = z
      .object({
        query: z.string(),
        variables: z.object({ id: z.string() }).strict(),
      })
      .strict()
      .safeParse(body);
    if (parsed.success && parsed.data.variables.id === expected.threadId) {
      const query = parsed.data.query.replace(/\s/g, "");
      if (query === targetQuery) return null;
      if (query === (expected.resolved ? resolveQuery : unresolveQuery))
        return "api";
    }
  }
  throw denied();
}
