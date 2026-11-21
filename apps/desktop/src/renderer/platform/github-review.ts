import type {
  PrCommentResult,
  PrInlineReview,
  PrLineCommentInput,
  PrReviewTarget,
  PrReviewDiff,
  PrThreadReplyInput,
  PrThreadResolveInput,
} from "@zeros/protocol/github-review";
import { requestCloudGithubPrFor } from "./cloud-github-pr";
import { getActiveBridge } from "./bridge/active-bridge";
import { workspaceOp } from "./bridge/workspace-bridge";

function request<T>(op: string, input: PrReviewTarget & { kind?: string }): Promise<T> {
  const cloud = requestCloudGithubPrFor(input.workspaceId, op, { ...input });
  if (cloud) return cloud as Promise<T>;
  const bridge = getActiveBridge();
  if (!bridge)
    return Promise.reject(
      new Error("Connect to the workspace to read or post review comments."),
    );
  return workspaceOp(bridge, op, { ...input }, 60_000) as Promise<T>;
}
export function getPrInlineReview(
  input: PrReviewTarget,
): Promise<PrInlineReview> {
  return request("gh.prInlineReview", input);
}
export function getPrReviewDiff(input: PrReviewTarget & { kind?: string }): Promise<PrReviewDiff> {
  return request("gh.prReviewDiff", input);
}
// The same actor-bound cloud grant covers all comment kinds; an omitted kind remains a conversation comment.
export function postPrLineComment(
  input: PrLineCommentInput,
): Promise<PrCommentResult> {
  return request("gh.prComment", { ...input, kind: "line" });
}
export function replyPrReviewThread(
  input: PrThreadReplyInput,
): Promise<PrCommentResult> {
  return request("gh.prComment", { ...input, kind: "reply" });
}
export function setPrReviewThreadResolved(
  input: PrThreadResolveInput,
): Promise<void> {
  return request("gh.prComment", { ...input, kind: "resolve" });
}
