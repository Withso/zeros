/** Use the engine bridge for durable review state, even in Electron; preload IPC owns host-only resources. */
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
