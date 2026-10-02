import { z } from "zod";

/** GitHub owns these identities and anchors. Workspace discussions use the
 * separate code-review contract; importing a review never impersonates its author. */
export interface PrReviewComment {
  id: string;
  databaseId: number | null;
  author: { login: string; avatarUrl: string | null; kind: "human" | "bot" };
  body: string;
  url: string | null;
  createdAt: number;
  updatedAt: number;
  commitSha: string | null;
}

export interface PrReviewThread {
  id: string;
  path: string;
  side: "LEFT" | "RIGHT";
  startLine: number | null;
  line: number | null;
  originalStartLine: number | null;
  originalLine: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  canResolve: boolean;
  canUnresolve: boolean;
  comments: PrReviewComment[];
  commentsTruncated: boolean;
  /** Original selected source, when recoverable from GitHub's stored hunk. */
  context?: string;
}

export interface PrCodeAnnotation {
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
}

export interface PrInlineReview {
  headSha: string;
  baseSha: string;
  threads: PrReviewThread[];
  annotations: PrCodeAnnotation[];
  threadsTruncated: boolean;
  annotationsTruncated: boolean;
  /** A failed annotations read must not hide successfully loaded discussions. */
  annotationError: string | null;
}

export interface PrReviewDiff {
  headSha: string;
  baseSha: string;
  patch: string;
}

const line = z.number().int().positive().max(2_147_483_647);
export const githubReviewPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/^[\\/]|^[A-Za-z]:|[\0-\x1f\\]/.test(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "A repository-relative file path is required",
  );
export const githubReviewBodySchema = z
  .string()
  .max(60_000)
  .refine(
    (value) => value.trim().length > 0 && !value.includes("\0"),
    "Write a comment before posting",
  );
export const githubReviewTargetSchema = z.object({
  workspaceId: z.string().min(1).max(4096),
  prNumber: line,
});
export const prLineCommentSchema = githubReviewTargetSchema
  .extend({
    body: githubReviewBodySchema,
    path: githubReviewPathSchema,
    side: z.enum(["LEFT", "RIGHT"]),
    line,
    startLine: line.optional(),
    commitSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
    baseSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  })
  .refine(
    (input) => input.startLine === undefined || input.startLine <= input.line,
    "The comment range must end after it starts",
  );
export const prThreadReplySchema = githubReviewTargetSchema.extend({
  body: githubReviewBodySchema,
  commentId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const prThreadResolveSchema = githubReviewTargetSchema.extend({
  threadId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_+/=-]+$/),
  resolved: z.boolean(),
});
export type PrReviewTarget = z.infer<typeof githubReviewTargetSchema>;
export type PrLineCommentInput = z.infer<typeof prLineCommentSchema>;
export type PrThreadReplyInput = z.infer<typeof prThreadReplySchema>;
export type PrThreadResolveInput = z.infer<typeof prThreadResolveSchema>;
export interface PrCommentResult {
  id: number;
  url: string;
}
