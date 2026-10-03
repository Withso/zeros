/** Durable review state always uses the engine bridge, including Electron.
 * Native/preload IPC is reserved for host-only resources. */
export {
  listCodeReviewThreads,
  createCodeReviewThread,
  replyCodeReviewThread,
  setCodeReviewThreadResolved,
} from "./bridge/code-review-bridge";
export type {
  CodeReviewActor, CodeReviewAnchor, CodeReviewComment, CodeReviewThread,
  CodeReviewListInput, CodeReviewListResult, CodeReviewCreateInput,
  CodeReviewReplyInput, CodeReviewSetResolvedInput,
} from "@zeros/protocol/code-review";
export { mergeCodeReviewThreads } from "@zeros/protocol/code-review";
