import {
  codeReviewCreateInputSchema, codeReviewListInputSchema, codeReviewListResultSchema,
  codeReviewReplyInputSchema, codeReviewSetResolvedInputSchema, codeReviewThreadSchema,
  type CodeReviewCreateInput, type CodeReviewListInput, type CodeReviewListResult,
  type CodeReviewReplyInput, type CodeReviewSetResolvedInput, type CodeReviewThread,
} from "@zeros/protocol/code-review";
import type { z } from "zod";
import { getActiveBridge } from "./active-bridge";
import { workspaceOp, WorkspaceOpError } from "./workspace-bridge";
import { resolveBridgeWorkspaceIdForCwd } from "./workspace-id-resolver";
import { runtimeExecutionKey } from "./ws-client";
import { codeReviewAvailable, codeReviewTarget } from "./code-review-availability";
import { cloudWorkspaceKey } from "./cloud-workspace-key";

export { mergeCodeReviewThreads } from "@zeros/protocol/code-review";

// Renderer-only placement context; strip it before strict Local wire parsing.
// A native workspace id must not hide a cloud cwd at this boundary.
type ReviewInput<Input> = Input & { cwd?: string };

async function reviewOperation<Input extends { workspaceId: string }, Output extends CodeReviewThread | CodeReviewListResult>(
  op: string, schema: z.ZodType<Input>, resultSchema: z.ZodType<Output>, raw: ReviewInput<Input>,
): Promise<Output> {
  const { cwd, ...wire } = raw;
  if (!codeReviewAvailable({ cwd, workspaceId: raw.workspaceId }))
    throw new Error("Review comments are unavailable for cloud workspaces.");
  const input = schema.parse(wire);
  const target = codeReviewTarget({ cwd, workspaceId: input.workspaceId });
  const bridge = getActiveBridge();
  if (!bridge) throw new Error("Connect to the workspace to read or write review comments.");
  const identity = runtimeExecutionKey(bridge.executionIdentity);
  const assertCurrent = () => {
    if (getActiveBridge() !== bridge || runtimeExecutionKey(bridge.executionIdentity) !== identity)
      throw new Error("The workspace connection changed. Retry the review operation.");
  };
  const workspaceId = target ? cloudWorkspaceKey(target) : await resolveBridgeWorkspaceIdForCwd(bridge, input.workspaceId) ?? input.workspaceId;
  assertCurrent();
  if (!codeReviewAvailable({ workspaceId }))
    throw new Error("Review comments are unavailable for cloud workspaces.");
  const params = { ...input, workspaceId };
  let value: unknown;
  if (target) {
    // A passive comment read must not reopen a peer after a Stop/status race.
    const response = await bridge.requestConnected({ type: "WORKSPACE_REQUEST", op, params }, 10_000);
    assertCurrent();
    if (response.type === "WORKSPACE_ERROR") throw new WorkspaceOpError(response);
    if (response.type !== "WORKSPACE_RESPONSE" || response.op !== op) throw new Error("Invalid review response.");
    value = response.result;
  } else value = await workspaceOp(bridge, op, params);
  const result = resultSchema.parse(value);
  assertCurrent();
  if (result.workspaceId !== workspaceId || ("threads" in result && result.threads.some((thread) => thread.workspaceId !== workspaceId)))
    throw new Error("The review response belongs to another workspace.");
  return result;
}

export const listCodeReviewThreads = (input: ReviewInput<CodeReviewListInput>): Promise<CodeReviewListResult> =>
  reviewOperation("codeReview.list", codeReviewListInputSchema, codeReviewListResultSchema, input);
export const createCodeReviewThread = (input: ReviewInput<CodeReviewCreateInput>): Promise<CodeReviewThread> =>
  reviewOperation("codeReview.create", codeReviewCreateInputSchema, codeReviewThreadSchema, input);
export const replyCodeReviewThread = (input: ReviewInput<CodeReviewReplyInput>): Promise<CodeReviewThread> =>
  reviewOperation("codeReview.reply", codeReviewReplyInputSchema, codeReviewThreadSchema, input);
export const setCodeReviewThreadResolved = (input: ReviewInput<CodeReviewSetResolvedInput>): Promise<CodeReviewThread> =>
  reviewOperation("codeReview.setResolved", codeReviewSetResolvedInputSchema, codeReviewThreadSchema, input);
