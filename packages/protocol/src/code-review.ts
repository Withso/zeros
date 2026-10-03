import { z } from "zod";

/** Comments are workspace data. Anchors identify the original view and are
 * never silently moved when a file changes. All ranges are inclusive, 1-based. */
export const CODE_REVIEW_BODY_LIMIT = 20_000;
export const CODE_REVIEW_CONTEXT_LIMIT = 4_096;
export const CODE_REVIEW_PAGE_BYTE_LIMIT = 512 * 1_024;
export const CODE_REVIEW_PAGE_THREAD_LIMIT = 100;
const noControls = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
const identity = z.string().min(1).max(512).refine(noControls);
const workspaceIdentity = z.string().min(1).max(4_096).refine(noControls);
const timestamp = z.number().int().safe().nonnegative();

export const codeReviewPathSchema = z.string().min(1).max(4_096).refine(
  (value) => noControls(value) && !value.includes("\\") &&
    !value.startsWith("/") && !/^[A-Za-z]:/.test(value) &&
    value.split("/").every((part) => !!part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
  "Use a normalized workspace-relative file path.",
);
export const codeReviewActorSchema = z.object({
  id: identity,
  name: z.string().min(1).max(256).refine(noControls).refine((value) => !!value.trim()),
  kind: z.enum(["human", "agent", "integration"]),
  provider: z.string().min(1).max(64).refine(noControls).optional(),
}).strict();
export const codeReviewAnchorSchema = z.object({
  path: codeReviewPathSchema,
  side: z.enum(["old", "new", "file"]),
  startLine: z.number().int().safe().positive().max(10_000_000),
  endLine: z.number().int().safe().positive().max(10_000_000),
  revision: z.string().min(1).max(1_024).refine(noControls).refine((value) => !!value.trim()),
  context: z.string().max(CODE_REVIEW_CONTEXT_LIMIT).refine((value) => !value.includes("\0")).optional(),
}).strict().refine((value) => value.endLine >= value.startLine, {
  message: "The end line must follow the start line.", path: ["endLine"],
});
export const codeReviewBodySchema = z.string().min(1).max(CODE_REVIEW_BODY_LIMIT)
  .refine((value) => !!value.trim() && !value.includes("\0"), "Enter a nonempty comment.");
export const codeReviewCommentSchema = z.object({
  id: identity,
  author: codeReviewActorSchema,
  body: codeReviewBodySchema,
  createdAt: timestamp,
  sequence: z.number().int().safe().positive().optional(),
}).strict();
export const codeReviewThreadSchema = z.object({
  id: identity,
  workspaceId: workspaceIdentity,
  anchor: codeReviewAnchorSchema,
  comments: z.array(codeReviewCommentSchema).min(1),
  resolved: z.boolean(),
  version: z.number().int().safe().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
  resolvedBy: codeReviewActorSchema.optional(),
  resolvedAt: timestamp.optional(),
  commentCount: z.number().int().safe().positive().optional(),
  commentsComplete: z.boolean().optional(),
  commentsCursor: z.string().min(1).max(2_048).optional(),
  commentsCursorAfter: z.number().int().safe().nonnegative().optional(),
}).strict();
const requestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional();
export const codeReviewListInputSchema = z.object({
  workspaceId: workspaceIdentity,
  path: codeReviewPathSchema.optional(),
  includeResolved: z.boolean().optional(),
  threadId: identity.optional(),
  cursor: z.string().min(1).max(2_048).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.number().int().min(1).max(CODE_REVIEW_PAGE_THREAD_LIMIT).optional(),
}).strict();
export const codeReviewCreateInputSchema = z.object({
  workspaceId: workspaceIdentity,
  anchor: codeReviewAnchorSchema,
  body: codeReviewBodySchema,
  requestId,
}).strict();
export const codeReviewReplyInputSchema = z.object({
  workspaceId: workspaceIdentity,
  threadId: identity,
  body: codeReviewBodySchema,
  requestId,
}).strict();
export const codeReviewSetResolvedInputSchema = z.object({
  workspaceId: workspaceIdentity,
  threadId: identity,
  resolved: z.boolean(),
  expectedVersion: z.number().int().safe().positive(),
  requestId,
}).strict();
export const codeReviewListResultSchema = z.object({
  workspaceId: workspaceIdentity,
  threads: z.array(codeReviewThreadSchema),
  partial: z.boolean().optional(),
  nextCursor: z.string().min(1).max(2_048).optional(),
  viewerActorId: identity.optional(),
}).strict();

export type CodeReviewActor = z.infer<typeof codeReviewActorSchema>;
export type CodeReviewAnchor = z.infer<typeof codeReviewAnchorSchema>;
export type CodeReviewComment = z.infer<typeof codeReviewCommentSchema>;
export type CodeReviewThread = z.infer<typeof codeReviewThreadSchema>;
export type CodeReviewListInput = z.infer<typeof codeReviewListInputSchema>;
export type CodeReviewCreateInput = z.infer<typeof codeReviewCreateInputSchema>;
export type CodeReviewReplyInput = z.infer<typeof codeReviewReplyInputSchema>;
export type CodeReviewSetResolvedInput = z.infer<typeof codeReviewSetResolvedInputSchema>;
export type CodeReviewListResult = z.infer<typeof codeReviewListResultSchema>;

export const CODE_REVIEW_OPERATIONS = [
  "codeReview.list", "codeReview.create", "codeReview.reply", "codeReview.setResolved",
] as const;
export type CodeReviewOperation = typeof CODE_REVIEW_OPERATIONS[number];
export const isCodeReviewOperation = (op: string): op is CodeReviewOperation =>
  (CODE_REVIEW_OPERATIONS as readonly string[]).includes(op);

/** Pages and mutation previews may overlap. Comment IDs/sequence are immutable;
 * the latest version owns state, while missing history remains explicit. */
export function mergeCodeReviewThreads(previous: readonly CodeReviewThread[], incoming: readonly CodeReviewThread[]): CodeReviewThread[] {
  const threads = new Map(previous.map((thread) => [thread.id, thread]));
  for (const thread of incoming) {
    const prior = threads.get(thread.id);
    if (!prior) { threads.set(thread.id, thread); continue; }
    if (prior.workspaceId !== thread.workspaceId) throw new Error("Review pages belong to different workspaces.");
    const commentsById = new Map(prior.comments.map((comment) => [comment.id, comment]));
    for (const comment of thread.comments) if (!commentsById.has(comment.id)) commentsById.set(comment.id, comment);
    const comments = [...commentsById.values()].sort((a, b) =>
      a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence : a.createdAt - b.createdAt);
    const latest = thread.version >= prior.version ? thread : prior;
    const commentCount = latest.commentCount ?? comments.length;
    const complete = comments.length >= commentCount;
    const contiguousEnd = (entries: readonly CodeReviewComment[], start = 1) => {
      const sequences = new Set(entries.map((comment) => comment.sequence));
      let next = start;
      while (sequences.has(next)) next++;
      return next - 1;
    };
    const prefixEnd = contiguousEnd(comments);
    let continuation: { cursor: string; after: number } | undefined;
    for (const source of [prior, thread]) {
      if (!source.commentsCursor) continue;
      // Older producers omit the explicit cursor position. A contiguous chunk
      // ends at its last sequence; a root/latest preview stops before its gap.
      const after = source.commentsCursorAfter ?? contiguousEnd(source.comments, source.comments[0]?.sequence ?? 1);
      if (after <= prefixEnd && (!continuation || after >= continuation.after))
        continuation = { cursor: source.commentsCursor, after };
    }
    const { commentsCursor: _cursor, commentsCursorAfter: _after, ...metadata } = latest;
    threads.set(thread.id, {
      ...metadata, comments, commentCount, commentsComplete: complete,
      ...(!complete && continuation ? { commentsCursor: continuation.cursor, commentsCursorAfter: continuation.after } : {}),
    });
  }
  return [...threads.values()];
}
