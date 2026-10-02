import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { codeReviewPathSchema } from "./code-review";
export { parseMergeConflicts, applyConflictChoices } from "./merge-conflicts";
export type {
  MergeConflict,
  MergeConflictParseResult,
  ConflictChoice,
} from "./merge-conflicts";
export {
  splitReviewHunks,
  reverseReviewHunkContent,
  untrackedReviewPatch,
} from "./review-hunks";
export type { ReviewHunk } from "./review-hunks";

const utf8 = new TextEncoder();
const text = z
  .string()
  .max(2_000_000)
  .refine(
    (value) => !value.includes("\0") && utf8.encode(value).length <= 2_000_000,
    "Text exceeds the review file limit.",
  );
const workspaceId = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
export const reviewComparisonSchema = z.enum([
  "worktree-vs-head",
  "worktree-vs-index",
]);
export type ReviewComparison = z.infer<typeof reviewComparisonSchema>;
export const reviewHunksInputSchema = z
  .object({ workspaceId, path: codeReviewPathSchema })
  .strict();
export const reviewHunkInputSchema = reviewHunksInputSchema
  .extend({
    comparison: reviewComparisonSchema,
    patch: z
      .string()
      .min(1)
      .max(4_000_000)
      .refine(
        (value) =>
          !value.includes("\0") && utf8.encode(value).length <= 4_000_000,
      ),
    expectedContent: text.nullable(),
    decision: z.enum(["accepted", "rejected"]),
    confirm: z.boolean().optional(),
  })
  .strict();
export const resolveConflictInputSchema = reviewHunksInputSchema
  .extend({
    expectedContent: text,
    content: text,
    choices: z.record(
      z.string().regex(/^conflict-\d+$/),
      z.enum(["current", "incoming", "both"]),
    ),
  })
  .strict();
export const hunkReviewDecisionSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    path: codeReviewPathSchema,
    comparison: reviewComparisonSchema,
    decision: z.enum(["accepted", "rejected"]),
    updatedAt: z.number().int().safe().nonnegative(),
  })
  .strict();
export type HunkReviewDecision = z.infer<typeof hunkReviewDecisionSchema>;
export type ReviewHunksInput = z.infer<typeof reviewHunksInputSchema>;
export type ReviewHunkInput = z.infer<typeof reviewHunkInputSchema>;
export type ResolveConflictInput = z.infer<typeof resolveConflictInputSchema>;
export interface HunkReviewResult {
  decision: HunkReviewDecision;
  fileChanged: boolean;
}
export interface ConflictResolutionResult {
  kind: "success";
  path: string;
  bytes: number;
}
export const GIT_REVIEW_OPERATIONS = [
  "git.reviewHunks",
  "git.reviewHunk",
  "git.resolveConflict",
] as const;
export type GitReviewOperation = (typeof GIT_REVIEW_OPERATIONS)[number];
export const isGitReviewOperation = (op: string): op is GitReviewOperation =>
  (GIT_REVIEW_OPERATIONS as readonly string[]).includes(op);

/** Call once per file snapshot in the renderer, then reuse for all hunk keys. */
export function reviewContentRevision(content: string | null): string {
  return bytesToHex(
    sha256(utf8.encode(content === null ? "absent" : `text\0${content}`)),
  );
}
export function reviewHunkKey(
  path: string,
  comparison: ReviewComparison,
  patch: string,
  contentRevision: string,
): string {
  return bytesToHex(
    sha256(
      utf8.encode(JSON.stringify([path, comparison, contentRevision, patch])),
    ),
  );
}
