import type {
  DesignReviewScope,
  DesignReviewSnapshot,
  DesignProposalReview,
  DesignReviewFileDetail,
  DesignReviewProposal,
} from "@zeros/protocol/design-review";
import { getActiveBridge } from "./active-bridge";
import { workspaceOp } from "./workspace-bridge";

export async function designReviewOperation<T>(
  op: string,
  params: Record<string, unknown>,
): Promise<T> {
  const bridge = getActiveBridge();
  if (!bridge)
    throw new Error("Connect to the workspace to review Design changes.");
  return (await workspaceOp(bridge, op, params)) as T;
}
export const readDesignReview = (
  workspaceId: string,
  scope: DesignReviewScope,
  offset = 0,
) =>
  designReviewOperation<DesignReviewSnapshot>("design.review.snapshot", {
    workspaceId,
    scope,
    offset,
    limit: 64,
  });
export const readDesignReviewFile = (
  workspaceId: string,
  directoryId: string,
  scope: Exclude<DesignReviewScope, "proposals">,
  path: string,
  oldPath?: string,
) =>
  designReviewOperation<DesignReviewFileDetail>("design.review.file", {
    workspaceId,
    directoryId,
    scope,
    path,
    ...(oldPath ? { oldPath } : {}),
  });
export const readDesignProposalReview = (
  workspaceId: string,
  directoryId: string,
  actorId: string,
  requestId: string,
) =>
  designReviewOperation<DesignProposalReview>("design.review.proposal", {
    workspaceId,
    directoryId,
    actorId,
    requestId,
  });
export const resolveDesignProposalReview = (
  workspaceId: string,
  directoryId: string,
  proposal: DesignReviewProposal,
  decision: "accept" | "reject",
) =>
  designReviewOperation<DesignReviewProposal>("design.review.resolve", {
    workspaceId,
    directoryId,
    actorId: proposal.actorId,
    requestId: proposal.id,
    signature: proposal.signature,
    decision,
  });
