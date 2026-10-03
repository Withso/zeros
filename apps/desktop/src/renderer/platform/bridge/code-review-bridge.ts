import {
  codeReviewCreateInputSchema, codeReviewListInputSchema, codeReviewListResultSchema,
  codeReviewReplyInputSchema, codeReviewSetResolvedInputSchema, codeReviewThreadSchema,
  type CodeReviewCreateInput, type CodeReviewListInput, type CodeReviewListResult,
  type CodeReviewReplyInput, type CodeReviewSetResolvedInput, type CodeReviewThread,
} from "@zeros/protocol/code-review";
import type { z } from "zod";
import { getActiveBridge } from "./active-bridge";
import { workspaceOp } from "./workspace-bridge";
import { resolveBridgeWorkspaceIdForCwd } from "./workspace-id-resolver";
import { runtimeExecutionKey } from "./ws-client";

export { mergeCodeReviewThreads } from "@zeros/protocol/code-review";

async function reviewOperation<Input extends { workspaceId: string }, Output extends CodeReviewThread | CodeReviewListResult>(
  op: string, schema: z.ZodType<Input>, resultSchema: z.ZodType<Output>, raw: Input,
): Promise<Output> {
  const input = schema.parse(raw);
  const bridge = getActiveBridge();
  if (!bridge) throw new Error("Connect to the workspace to read or write review comments.");
  const identity = runtimeExecutionKey(bridge.executionIdentity);
  const assertCurrent = () => {
    if (getActiveBridge() !== bridge || runtimeExecutionKey(bridge.executionIdentity) !== identity)
      throw new Error("The workspace connection changed. Retry the review operation.");
  };
  const workspaceId = await resolveBridgeWorkspaceIdForCwd(bridge, input.workspaceId) ?? input.workspaceId;
  assertCurrent();
  const result = resultSchema.parse(await workspaceOp(bridge, op, { ...input, workspaceId }));
  assertCurrent();
  if (result.workspaceId !== workspaceId || ("threads" in result && result.threads.some((thread) => thread.workspaceId !== workspaceId)))
    throw new Error("The review response belongs to another workspace.");
  return result;
}

export const listCodeReviewThreads = (input: CodeReviewListInput): Promise<CodeReviewListResult> =>
  reviewOperation("codeReview.list", codeReviewListInputSchema, codeReviewListResultSchema, input);
export const createCodeReviewThread = (input: CodeReviewCreateInput): Promise<CodeReviewThread> =>
  reviewOperation("codeReview.create", codeReviewCreateInputSchema, codeReviewThreadSchema, input);
export const replyCodeReviewThread = (input: CodeReviewReplyInput): Promise<CodeReviewThread> =>
  reviewOperation("codeReview.reply", codeReviewReplyInputSchema, codeReviewThreadSchema, input);
export const setCodeReviewThreadResolved = (input: CodeReviewSetResolvedInput): Promise<CodeReviewThread> =>
  reviewOperation("codeReview.setResolved", codeReviewSetResolvedInputSchema, codeReviewThreadSchema, input);
