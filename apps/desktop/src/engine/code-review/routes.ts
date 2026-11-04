import { handleCodeReviewRouteCore, type CodeReviewActor, type CodeReviewOperation, type CodeReviewRouteHost } from "@zeros/protocol/code-review";
import { codeReviewStore, type CodeReviewStore } from "../db/code-review";
import { codeReviewHumanActor } from "./actors";
import { assertCodeReviewPath, type CodeReviewPathPolicy } from "./paths";
export type { CodeReviewRouteHost } from "@zeros/protocol/code-review";

export interface CodeReviewRouteOptions extends CodeReviewPathPolicy {
  /** Trusted engine-side actor; never part of a public request schema. */
  actor?: CodeReviewActor;
  userId?: string;
  userName?: string;
}
export function handleCodeReviewRoute(
  host: CodeReviewRouteHost, operation: CodeReviewOperation, raw: unknown,
  options: CodeReviewRouteOptions = {}, store: CodeReviewStore = codeReviewStore,
): unknown {
  return handleCodeReviewRouteCore(host, operation, raw, {
    ...options, assertPath: assertCodeReviewPath,
    author: () => options.actor ?? codeReviewHumanActor(options.userId, options.remote, options.userName),
    viewer: !!(options.actor || options.userId || !options.remote),
  }, store);
}
