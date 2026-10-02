import type {
  CodeReviewAnchor,
  CodeReviewComment,
} from "@zeros/protocol/code-review";

/** UI shape shared by durable workspace discussions, GitHub threads and checks. */
export interface CodeReviewThreadItem {
  id: string;
  source: "workspace" | "github" | "check";
  anchor: CodeReviewAnchor;
  comments: readonly CodeReviewComment[];
  resolved: boolean;
  version: number | string;
  outdated?: boolean;
  anchorMissing?: boolean;
  truncated?: boolean;
  url?: string;
  severity?: "notice" | "warning" | "failure";
  canReply?: boolean;
  canResolve?: boolean;
  commentCount?: number;
  commentsComplete?: boolean;
  commentsCursor?: string;
  commentsCursorAfter?: number;
}

export interface CodeReviewExternalSource {
  threads: readonly CodeReviewThreadItem[];
  loading?: boolean;
  error?: Error | string | null;
  notice?: string | null;
  reply?: (thread: CodeReviewThreadItem, body: string) => Promise<void>;
  setResolved?: (
    thread: CodeReviewThreadItem,
    resolved: boolean,
  ) => Promise<void>;
  /** Opaque exact provider/workspace/PR/base/head identity of the rendered diff. */
  confirmedRevision?: string;
  postComment?: (anchor: CodeReviewAnchor, body: string) => Promise<void>;
  /** Kept explicit for adapters that supply a destination-specific composer. */
  createLabel?: string;
}

export interface CodeReviewOperations {
  create: (
    anchor: CodeReviewAnchor,
    body: string,
    requestId: string,
  ) => Promise<void>;
  reply: (
    thread: CodeReviewThreadItem,
    body: string,
    requestId: string,
  ) => Promise<void>;
  setResolved: (
    thread: CodeReviewThreadItem,
    resolved: boolean,
  ) => Promise<void>;
  loadMoreComments?: (thread: CodeReviewThreadItem) => Promise<void>;
}

export const EMPTY_REVIEW_THREADS: readonly CodeReviewThreadItem[] =
  Object.freeze([]);

export function reviewThreadKey(
  thread: Pick<CodeReviewThreadItem, "id" | "source">,
): string {
  return `${thread.source}:${thread.id}`;
}

const renderVersions = new WeakMap<CodeReviewThreadItem, string>();
/** Loading history changes the rendered snapshot without a server mutation. */
export function reviewThreadRenderVersion(
  thread: CodeReviewThreadItem,
): string {
  let version = renderVersions.get(thread);
  if (!version) {
    version = JSON.stringify([
      thread.version,
      thread.resolved,
      thread.outdated,
      thread.anchorMissing,
      thread.truncated,
      thread.commentCount,
      thread.commentsComplete,
      thread.commentsCursor,
      thread.comments.map((comment) => comment.id),
    ]);
    renderVersions.set(thread, version);
  }
  return version;
}

export function reviewRangeLabel(anchor: CodeReviewAnchor): string {
  const side =
    anchor.side === "old" ? "Old " : anchor.side === "new" ? "New " : "";
  return anchor.startLine === anchor.endLine
    ? `${side}line ${anchor.startLine}`
    : `${side}lines ${anchor.startLine}–${anchor.endLine}`;
}
