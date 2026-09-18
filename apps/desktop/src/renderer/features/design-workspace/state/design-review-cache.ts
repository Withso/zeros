import type { DesignReviewEvidence } from "@zeros/protocol/design-review";
import { designReviewOperation } from "../../../platform/bridge/design-review-bridge";
import type { DesignReviewScope } from "@zeros/protocol/design-review";
import {
  readDesignReview,
  readDesignReviewFile,
  readDesignProposalReview,
} from "../../../platform/bridge/design-review-bridge";
import {
  designReviewCache,
  designReviewDetailCache,
} from "../../../state/read-caches";

export const DESIGN_REVIEW_MAX_AGE = 15_000;
export const designReviewKey = (
  workspaceId: string,
  scope: DesignReviewScope = "uncommitted",
  offset = 0,
) => JSON.stringify([workspaceId, scope, offset]);
export async function fetchDesignReview(key: string) {
  const [workspaceId, scope, offset] = JSON.parse(key) as [
    string,
    DesignReviewScope,
    number,
  ];
  const next = await readDesignReview(workspaceId, scope, offset);
  const previous = designReviewCache.peekSnapshot(key).data;
  return previous && JSON.stringify(previous) === JSON.stringify(next)
    ? previous
    : next;
}
export async function fetchDesignReviewDetail(key: string) {
  const [workspaceId, directoryId, kind, ...identity] = JSON.parse(
    key,
  ) as string[];
  const next =
    kind === "proposal"
      ? await readDesignProposalReview(
          workspaceId!,
          directoryId!,
          identity[0]!,
          identity[1]!,
        )
      : await readDesignReviewFile(
          workspaceId!,
          directoryId!,
          kind as Exclude<DesignReviewScope, "proposals">,
          identity[0]!,
          identity[1] || undefined,
        );
  const previous = designReviewDetailCache.peekSnapshot(key).data;
  return previous && JSON.stringify(previous) === JSON.stringify(next)
    ? previous
    : next;
}
export function warmDesignReview(workspaceId: string) {
  const key = designReviewKey(workspaceId);
  void designReviewCache
    .load(key, () => fetchDesignReview(key), {
      maxAgeMs: DESIGN_REVIEW_MAX_AGE,
    })
    .catch(() => {});
}

export async function fetchDesignReviewEvidence(
  key: string,
): Promise<DesignReviewEvidence> {
  const [workspaceId, directoryId, actorId, requestId, signature, resultId] =
    JSON.parse(key) as string[];
  return designReviewOperation<DesignReviewEvidence>("design.review.evidence", {
    workspaceId,
    directoryId,
    actorId,
    requestId,
    signature,
    resultId,
  });
}
// Hovering across a long list may speculate at most two reads at once.
const speculativeDetails = new Set<string>();
export function warmDesignReviewDetail(key: string): void {
  if (speculativeDetails.has(key) || speculativeDetails.size >= 2) return;
  speculativeDetails.add(key);
  void designReviewDetailCache
    .load(key, () => fetchDesignReviewDetail(key), {
      maxAgeMs: DESIGN_REVIEW_MAX_AGE,
    })
    .catch(() => {})
    .finally(() => speculativeDetails.delete(key));
}
