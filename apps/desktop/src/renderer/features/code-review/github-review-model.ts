import type {
  PrCodeAnnotation,
  PrInlineReview,
  PrReviewThread,
  PrReviewTarget,
  PrLineCommentInput,
} from "@zeros/protocol/github-review";
import type { CodeReviewAnchor } from "@zeros/protocol/code-review";
import { reviewContentRevision } from "@zeros/protocol/git-review-actions";
import type { CodeReviewThreadItem } from "./review-thread-model";

const threadItems = new WeakMap<
  PrReviewThread,
  { revision: string; item: CodeReviewThreadItem }
>();
const annotationItems = new WeakMap<
  PrCodeAnnotation,
  { revision: string; item: CodeReviewThreadItem }
>();

type PublishedRevision = Pick<PrInlineReview, "baseSha" | "headSha">;

/** Anchor revisions include the destination as well as both immutable commits.
 * Hashing keeps long workspace paths inside the shared anchor size limit. */
export function githubReviewRevision(
  target: PrReviewTarget,
  snapshot: PublishedRevision,
): string {
  return `github-pr:${reviewContentRevision(JSON.stringify([target.workspaceId, target.prNumber, snapshot.baseSha, snapshot.headSha]))}`;
}

export function githubLineCommentForAnchor(
  target: PrReviewTarget,
  snapshot: PublishedRevision,
  anchor: CodeReviewAnchor,
  body: string,
  renamedPaths?: ReadonlyMap<string, string>,
): PrLineCommentInput {
  if (
    anchor.side === "file" ||
    anchor.revision !== githubReviewRevision(target, snapshot)
  ) {
    throw new Error(
      "The pull request or its diff changed. Select the current code before posting to PR.",
    );
  }
  return {
    ...target,
    body,
    path:
      anchor.side === "old"
        ? (renamedPaths?.get(anchor.path) ?? anchor.path)
        : anchor.path,
    side: anchor.side === "old" ? "LEFT" : "RIGHT",
    line: anchor.endLine,
    startLine: anchor.startLine,
    commitSha: snapshot.headSha,
    baseSha: snapshot.baseSha,
  };
}

export function githubReviewThreadItem(
  thread: PrReviewThread,
  revision: string,
): CodeReviewThreadItem {
  const cached = threadItems.get(thread);
  if (cached?.revision === revision) return cached.item;
  const endLine = thread.line ?? thread.originalLine ?? 1;
  const startLine = Math.min(
    thread.startLine ?? thread.originalStartLine ?? endLine,
    endLine,
  );
  const item: CodeReviewThreadItem = {
    id: thread.id,
    source: "github",
    anchor: {
      path: thread.path,
      side: thread.side === "LEFT" ? "old" : "new",
      startLine,
      endLine,
      revision,
      ...(thread.context !== undefined ? { context: thread.context } : {}),
    },
    comments: thread.comments.map((comment) => ({
      id: comment.id,
      author: {
        id: `github:${comment.author.login}`,
        name: comment.author.login,
        kind: comment.author.kind === "bot" ? "integration" : "human",
      },
      body: comment.body,
      createdAt: comment.createdAt,
    })),
    resolved: thread.isResolved,
    version: JSON.stringify([
      revision,
      thread.isResolved,
      thread.isOutdated,
      thread.comments.map((comment) => [comment.id, comment.updatedAt]),
    ]),
    outdated: thread.isOutdated || thread.line === null,
    anchorMissing: thread.line === null && thread.originalLine === null,
    truncated: thread.commentsTruncated,
    ...(thread.comments[0]?.url ? { url: thread.comments[0].url } : {}),
    canReply: thread.comments[0]?.databaseId != null,
    canResolve: thread.isResolved ? thread.canUnresolve : thread.canResolve,
  };
  threadItems.set(thread, { revision, item });
  return item;
}

export function githubAnnotationItem(
  annotation: PrCodeAnnotation,
  revision: string,
): CodeReviewThreadItem {
  const cached = annotationItems.get(annotation);
  if (cached?.revision === revision) return cached.item;
  const item: CodeReviewThreadItem = {
    id: annotation.id,
    source: "check",
    anchor: {
      path: annotation.path,
      side: "new",
      startLine: annotation.startLine,
      endLine: annotation.endLine,
      revision,
    },
    comments: [
      {
        id: annotation.id,
        author: {
          id: `check:${annotation.source}`,
          name: annotation.source,
          kind: "integration",
        },
        body: [annotation.title, annotation.message]
          .filter(Boolean)
          .join("\n\n"),
        createdAt: 0,
      },
    ],
    resolved: false,
    version: revision,
    severity: annotation.level,
    ...(annotation.url ? { url: annotation.url } : {}),
    canReply: false,
    canResolve: false,
  };
  annotationItems.set(annotation, { revision, item });
  return item;
}

export function githubReviewItems(
  snapshot: PrInlineReview,
  target: PrReviewTarget,
): readonly CodeReviewThreadItem[] {
  const revision = githubReviewRevision(target, snapshot);
  return [
    ...snapshot.threads.map((thread) =>
      githubReviewThreadItem(thread, revision),
    ),
    ...snapshot.annotations.map((annotation) =>
      githubAnnotationItem(annotation, revision),
    ),
  ];
}

export function githubReviewNotice(
  snapshot: PrInlineReview | undefined,
): string | undefined {
  if (!snapshot) return undefined;
  const partial =
    snapshot.threadsTruncated ||
    snapshot.annotationsTruncated ||
    snapshot.threads.some((thread) => thread.commentsTruncated);
  return (
    [
      snapshot.annotationError,
      partial
        ? "This large review is partially shown. Open GitHub to see every comment and annotation."
        : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined
  );
}
