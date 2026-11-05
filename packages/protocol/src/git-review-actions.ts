import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { codeReviewPathSchema } from "./code-review";
export { validateGitReference, requireGitPaths, validateGitReset, gitResetArgs, gitRestoreArgs } from "./git-operations";
export type { GitResetMode } from "./git-operations";
export { parseGitRemotes, parseGitCatalogRefs, parseGitBranchRefs, parseGitWorktrees } from "./git-branches";
export { parseMergeConflicts, applyConflictChoices } from "./merge-conflicts";
export type {
  MergeConflict,
  MergeConflictParseResult,
  ConflictChoice,
} from "./merge-conflicts";

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
const reviewFileInputSchema = z
  .object({ workspaceId, path: codeReviewPathSchema })
  .strict();
export const resolveConflictInputSchema = reviewFileInputSchema
  .extend({
    expectedContent: text,
    content: text,
    choices: z.record(
      z.string().regex(/^conflict-\d+$/),
      z.enum(["current", "incoming", "both"]),
    ),
  })
  .strict();
export type ResolveConflictInput = z.infer<typeof resolveConflictInputSchema>;
export interface ConflictResolutionResult {
  kind: "success";
  path: string;
  bytes: number;
}
export const GIT_REVIEW_OPERATIONS = ["git.resolveConflict"] as const;
export type GitReviewOperation = (typeof GIT_REVIEW_OPERATIONS)[number];
export const isGitReviewOperation = (op: string): op is GitReviewOperation =>
  (GIT_REVIEW_OPERATIONS as readonly string[]).includes(op);

/** One hash per file snapshot; code review anchors and thread keys reuse it. */
export function reviewContentRevision(content: string | null): string {
  return bytesToHex(
    sha256(utf8.encode(content === null ? "absent" : `text\0${content}`)),
  );
}
