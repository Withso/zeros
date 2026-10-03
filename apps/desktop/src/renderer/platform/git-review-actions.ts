import { z } from "zod";
import {
  reviewHunksInputSchema,
  reviewHunkInputSchema,
  resolveConflictInputSchema,
  hunkReviewDecisionSchema,
  type HunkReviewDecision,
  type HunkReviewResult,
  type ReviewHunkInput,
  type ResolveConflictInput,
  type ConflictResolutionResult,
} from "@zeros/protocol/git-review-actions";
import { getActiveBridge } from "./bridge/active-bridge";
import { resolveBridgeWorkspaceIdForCwd } from "./bridge/workspace-id-resolver";
import { workspaceOp } from "./bridge/workspace-bridge";

export interface HunkReviewsSnapshot {
  workspaceId: string;
  decisions: readonly HunkReviewDecision[];
}
export type WorkspaceHunkReviewInput = Omit<ReviewHunkInput, "workspaceId">;
export type WorkspaceConflictResolutionInput = Omit<
  ResolveConflictInput,
  "workspaceId"
>;
/** Injection is for browser harnesses; product callers use the engine client. */
export interface GitReviewActionsClient {
  identity: string;
  list(cwd: string, path: string): Promise<HunkReviewsSnapshot>;
  review(
    cwd: string,
    input: WorkspaceHunkReviewInput,
  ): Promise<HunkReviewResult>;
  resolveConflict(
    cwd: string,
    input: WorkspaceConflictResolutionInput,
  ): Promise<ConflictResolutionResult>;
}
const reviewResultSchema = z
  .object({ decision: hunkReviewDecisionSchema, fileChanged: z.boolean() })
  .strict();
const resolutionResultSchema = z
  .object({
    kind: z.literal("success"),
    path: z.string(),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

async function target(cwd: string) {
  const bridge = getActiveBridge();
  if (!bridge) throw new Error("Connect to the workspace to review changes.");
  const workspaceId =
    (await resolveBridgeWorkspaceIdForCwd(bridge, cwd)) ?? cwd;
  return { bridge, workspaceId };
}
export async function getWorkspaceHunkReviews(
  cwd: string,
  path: string,
): Promise<HunkReviewsSnapshot> {
  const input = reviewHunksInputSchema.parse({ workspaceId: cwd, path });
  const { bridge, workspaceId } = await target(input.workspaceId);
  const decisions = z
    .array(hunkReviewDecisionSchema)
    .max(1024)
    .parse(
      await workspaceOp(bridge, "git.reviewHunks", { ...input, workspaceId }),
    );
  return { workspaceId, decisions };
}
export async function setWorkspaceHunkReview(
  cwd: string,
  raw: WorkspaceHunkReviewInput,
): Promise<HunkReviewResult> {
  const input = reviewHunkInputSchema.parse({ ...raw, workspaceId: cwd });
  const { bridge, workspaceId } = await target(input.workspaceId);
  return reviewResultSchema.parse(
    await workspaceOp(
      bridge,
      "git.reviewHunk",
      { ...input, workspaceId },
      60_000,
    ),
  );
}
export async function saveWorkspaceConflictResolution(
  cwd: string,
  raw: WorkspaceConflictResolutionInput,
): Promise<ConflictResolutionResult> {
  const input = resolveConflictInputSchema.parse({ ...raw, workspaceId: cwd });
  const { bridge, workspaceId } = await target(input.workspaceId);
  return resolutionResultSchema.parse(
    await workspaceOp(
      bridge,
      "git.resolveConflict",
      { ...input, workspaceId },
      60_000,
    ),
  );
}
export const workspaceGitReviewClient: GitReviewActionsClient = Object.freeze({
  identity: "engine",
  list: getWorkspaceHunkReviews,
  review: setWorkspaceHunkReview,
  resolveConflict: saveWorkspaceConflictResolution,
});
