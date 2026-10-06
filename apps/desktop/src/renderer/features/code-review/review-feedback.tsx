import { useRef, useState } from "react";
import { Button } from "@/renderer/shared/ui/primitives";
import type { CodeReviewController } from "./use-code-review";
import { useWorkbenchStatusSource } from "../../shell/workbench/tab-status";

export function ReviewFeedback({ review }: { review: CodeReviewController }) {
  return <OwnerFeedback key={review.ownerKey} review={review} />;
}

function OwnerFeedback({ review }: { review: CodeReviewController }) {
  const externalError = review.external?.error;
  const message =
    review.error?.message ??
    (externalError instanceof Error ? externalError.message : externalError);
  const notice = review.external?.notice;
  const loading = review.loading || review.external?.loading;
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const moreFlight = useRef(false);
  const managed = useWorkbenchStatusSource(
    {
      error: message ?? moreError,
      pending: !!loading || moreBusy,
      retry: async () => {
        if (moreError && review.loadMore) {
          try {
            await review.loadMore();
            setMoreError(null);
          } catch (failure) {
            setMoreError(
                      failure instanceof Error
                        ? failure.message
                        : String(failure),
                    );
          }
        }
        await review.refresh();
      },
    },
    review.ownerKey,
  );
  if (
    !message &&
    !notice &&
    !loading &&
    !review.partial &&
    !review.nextCursor &&
    !moreError
  )
    return null;
  return (
    <div
      data-review-feedback
      className="text-fg3 flex flex-col gap-1 px-3 py-2 font-sans text-xs"
    >
      {loading && (
        <p role="status" aria-live="polite">
          Loading comments…
        </p>
      )}
      {message && !managed && (
        <div role="alert" className="flex items-center gap-2">
          <span className="text-red-primary break-words">{message}</span>
          {review.error && (
            <Button variant="ghost" onClick={review.refresh}>
              Retry comments
            </Button>
          )}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {(review.partial || review.nextCursor) && (
        <div className="flex items-center gap-2">
          <span>More workspace discussions are available.</span>
          {review.loadMore && (
            <Button
              variant="ghost"
              disabled={moreBusy}
              aria-busy={moreBusy || undefined}
              onClick={() => {
                if (moreFlight.current) return;
                moreFlight.current = true;
                setMoreBusy(true);
                setMoreError(null);
                void review.loadMore!()
                  .catch((failure) =>
                    setMoreError(
                      failure instanceof Error
                        ? failure.message
                        : String(failure),
                    ),
                  )
                  .finally(() => {
                    moreFlight.current = false;
                    setMoreBusy(false);
                  });
              }}
            >
              {moreBusy ? "Loading discussions…" : "Load more discussions"}
            </Button>
          )}
        </div>
      )}
      {moreError && !managed && (
        <p role="alert" className="text-red-primary">
          {moreError}
        </p>
      )}
    </div>
  );
}
