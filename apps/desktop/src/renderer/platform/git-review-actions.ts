import { z } from "zod";
import {
  resolveConflictInputSchema,
  type ResolveConflictInput,
  type ConflictResolutionResult,
} from "@zeros/protocol/git-review-actions";
import { getActiveBridge } from "./bridge/active-bridge";
import { resolveBridgeWorkspaceIdForCwd } from "./bridge/workspace-id-resolver";
import { workspaceOp } from "./bridge/workspace-bridge";

export type WorkspaceConflictResolutionInput = Omit<
  ResolveConflictInput,
  "workspaceId"
>;
/** Injection is for browser harnesses; product callers use the engine client. */
export interface GitReviewActionsClient {
  identity: string;
  resolveConflict(
    cwd: string,
    input: WorkspaceConflictResolutionInput,
  ): Promise<ConflictResolutionResult>;
}
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
  resolveConflict: saveWorkspaceConflictResolution,
});
