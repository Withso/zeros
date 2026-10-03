import type {
  PrCommentResult,
  PrInlineReview,
  PrLineCommentInput,
  PrReviewTarget,
  PrReviewDiff,
  PrThreadReplyInput,
  PrThreadResolveInput,
} from "@zeros/protocol/github-review";
import { getActiveBridge } from "./bridge/active-bridge";
import { workspaceOp } from "./bridge/workspace-bridge";

function request<T>(op: string, input: object): Promise<T> {
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
export function getPrReviewDiff(input: PrReviewTarget): Promise<PrReviewDiff> {
  return request("gh.prReviewDiff", input);
}
// The existing comment write operation keeps its conversation behavior when
// kind is absent. Explicit variants also use its actor-bound cloud write grant.
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
