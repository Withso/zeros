import { useState } from "react";
import {
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/renderer/shared/ui/primitives";
import { InlineReviewThread } from "./inline-review-thread";
import { ReviewComposer } from "./review-composer";
import { ReviewSelectionToolbar } from "./review-selection-toolbar";
import {
  reviewSelectionKey,
  type ReviewAnnotationPayload,
  type ReviewAnnotationThread,
  type ReviewSelectionTarget,
} from "./review-annotations";
import type { CodeReviewController } from "./use-code-review";
import { reviewRangeLabel, reviewThreadKey } from "./review-thread-model";
import { HunkReviewActions } from "./hunk-review-actions";
import { triggerGitRefresh } from "@/renderer/shell/use-git-refresh-key";

export function ReviewAnnotationView({
  payload,
  review,
  active,
  onSelect,
  onCancel,
  postComment,
}: {
  payload: ReviewAnnotationPayload;
  review: CodeReviewController;
  active: boolean;
  onSelect: (target: ReviewSelectionTarget) => void;
  onCancel: (target: ReviewSelectionTarget) => void;
  postComment?: (target: ReviewSelectionTarget, body: string) => Promise<void>;
}) {
  const commentsAvailable = review.commentsAvailable !== false;
  const workspaceCommentsAvailable = review.workspaceCommentsAvailable !== false;
  const selection = commentsAvailable ? payload.selection : undefined;
  if (!commentsAvailable && !payload.hunks?.length) return null;
  return (
    <div
      data-review-annotation
      className="flex min-w-0 flex-col gap-2 p-2 font-sans text-xs"
    >
      {payload.hunks?.map(({ key, ...hunk }) => (
        <HunkReviewActions
          key={key}
          {...hunk}
          active={active}
          onReviewed={(result) => {
            if (result.fileChanged) triggerGitRefresh(hunk.cwd);
          }}
        />
      ))}
      {commentsAvailable && payload.threads.map(({ thread, state }) => (
        <InlineReviewThread
          key={reviewThreadKey(thread)}
          thread={thread}
          state={state}
          operations={review.operations}
          drafts={review.drafts}
          active={active}
          viewerActorId={review.viewerActorId}
        />
      ))}
      {selection &&
        (selection.mode === "selection" ? (
          <ReviewSelectionToolbar
            anchor={selection.anchor}
            active={active}
            onComment={() => {
              review.drafts.requestFocus(
                `new:${reviewSelectionKey(selection)}`,
              );
              onSelect({ ...selection, mode: "composer" });
            }}
            onCancel={() => onCancel(selection)}
          />
        ) : (
          <div className="min-w-0">
            <ReviewComposer
              store={review.drafts}
              draftKey={`new:${reviewSelectionKey(selection)}`}
              label={`Comment on ${reviewRangeLabel(selection.anchor)}`}
              submitLabel={selection.postToPr ? "Post to PR" : "Comment"}
              active={active}
              onSubmit={async (body, requestId) => {
                if (selection.postToPr) {
                  if (!postComment)
                    throw new Error(
                      "The PR diff changed. Refresh it before posting to PR.",
                    );
                  await postComment(selection, body);
                } else if (workspaceCommentsAvailable)
                  await review.operations.create(
                    selection.anchor,
                    body,
                    requestId,
                  );
                else throw new Error("Private workspace comments are unavailable here. Use Post to PR on its published diff.");
              }}
              onCancel={() => onCancel(selection)}
              onSubmitted={() => onCancel(selection)}
              notice={
                selection.postToPr && !postComment ? (
                  <p
                    role="status"
                    className="text-yellow-primary m-0 text-xs leading-4.5"
                  >
                    The PR diff changed. Your draft is kept; select the current
                    range before posting to PR.
                  </p>
                ) : undefined
              }
              destination={
                postComment || selection.postToPr ? (
                  // Where the comment goes; the primary submit follows it.
                  <Tabs
                    value={selection.postToPr ? "pr" : "workspace"}
                    onValueChange={(value) =>
                      onSelect({ ...selection, postToPr: value === "pr" })
                    }
                  >
                    <TabsList aria-label="Comment destination">
                      {workspaceCommentsAvailable && (
                        <TabsTrigger value="workspace">Workspace</TabsTrigger>
                      )}
                      <TabsTrigger value="pr" disabled={!postComment}>
                        Pull request
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                ) : (
                  <span className="text-fg3 px-1 text-xs leading-4.5">
                    Workspace comment
                  </span>
                )
              }
            />
          </div>
        ))}
    </div>
  );
}

export function ReviewUnplacedThreads({
  entries,
  review,
  active,
  showPath = false,
}: {
  entries: readonly ReviewAnnotationThread[];
  review: CodeReviewController;
  active: boolean;
  showPath?: boolean;
}) {
  const [page, setPage] = useState(0);
  if (!entries.length || review.commentsAvailable === false) return null;
  const pageSize = 20;
  const lastPage = Math.max(0, Math.ceil(entries.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const shown = entries.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  return (
    <div
      data-review-unplaced
      className="flex min-w-0 flex-col gap-2 p-2 font-sans text-xs"
    >
      <p className="text-fg3">
        Discussions on an earlier or unavailable code range
      </p>
      {shown.map(({ thread, state }) => (
        <div key={reviewThreadKey(thread)} className="min-w-0">
          {showPath && (
            <p className="text-fg3 mb-1 truncate" title={thread.anchor.path}>
              {thread.anchor.path}
            </p>
          )}
          <InlineReviewThread
            thread={thread}
            state={state}
            operations={review.operations}
            drafts={review.drafts}
            active={active}
            viewerActorId={review.viewerActorId}
          />
        </div>
      ))}
      {lastPage > 0 && (
        <div className="text-fg3 flex items-center gap-2">
          <span>
            {currentPage * pageSize + 1}–
            {Math.min((currentPage + 1) * pageSize, entries.length)} of{" "}
            {entries.length}
          </span>
          <Button
            variant="ghost"
            disabled={currentPage === 0 || !active}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </Button>
          <Button
            variant="ghost"
            disabled={currentPage === lastPage || !active}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
