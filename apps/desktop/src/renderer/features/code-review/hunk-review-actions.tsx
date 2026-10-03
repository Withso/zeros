import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Check, Undo2 } from "lucide-react";
import {
  reviewContentRevision,
  reviewHunkKey,
  splitReviewHunks,
  type ReviewComparison,
  type HunkReviewResult,
} from "@zeros/protocol/git-review-actions";
import { Button } from "@/renderer/shared/ui/primitives/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/renderer/shared/ui/primitives/dialog";
import {
  workspaceGitReviewClient,
  type GitReviewActionsClient,
} from "@/renderer/platform/git-review-actions";
import { hunkReviewCache, publishHunkReview } from "./hunk-review-cache";
import { useHunkReviews } from "./use-hunk-reviews";
import { beginReviewCacheRequest } from "./review-cache-forget";

export interface HunkReviewActionsProps {
  cwd: string;
  path: string;
  /** Complete one-hunk Git patch, extracted from the displayed comparison. */
  patch: string;
  comparison: ReviewComparison;
  /** Exact confirmed live-file bytes; null only for a confirmed deleted file. */
  expectedContent: string | null;
  /** Compute once per file with reviewContentRevision, then share across rows. */
  contentRevision?: string;
  active?: boolean;
  readOnly?: boolean;
  designPath?: boolean;
  onReviewed?: (result: HunkReviewResult) => void;
  client?: GitReviewActionsClient;
}

export const HunkReviewActions = memo(function HunkReviewActions({
  cwd,
  path,
  patch,
  comparison,
  expectedContent,
  contentRevision,
  active = true,
  readOnly = false,
  designPath = false,
  onReviewed,
  client = workspaceGitReviewClient,
}: HunkReviewActionsProps) {
  const reviewable = useMemo(
    () => splitReviewHunks(patch).length === 1,
    [patch],
  );
  const enabled =
    active &&
    !readOnly &&
    !designPath &&
    reviewable &&
    (comparison === "worktree-vs-head" || comparison === "worktree-vs-index");
  const revision = useMemo(
    () => contentRevision ?? reviewContentRevision(expectedContent),
    [contentRevision, expectedContent],
  );
  const key = useMemo(
    () => reviewHunkKey(path, comparison, patch, revision),
    [path, comparison, patch, revision],
  );
  const snapshot = useHunkReviews(cwd, path, enabled, client);
  const currentKey = `${snapshot.key}:${key}`;
  const current = useRef(currentKey);
  current.current = enabled ? currentKey : "";
  const pending = useRef(false);
  const mounted = useRef(true);
  const rejectButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const accepted =
    snapshot.data?.some(
      (decision) => decision.key === key && decision.decision === "accepted",
    ) ?? false;
  const error =
    failure?.key === currentKey ? failure.message : snapshot.error?.message;
  const confirming = enabled && confirmation === currentKey;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled) setConfirmation(null);
  }, [enabled]);

  const decide = async (decision: "accepted" | "rejected") => {
    if (!enabled || pending.current) return;
    const submittedKey = currentKey;
    pending.current = true;
    setBusy(submittedKey);
    setFailure(null);
    const request = beginReviewCacheRequest(cwd);
    try {
      const result = await client.review(cwd, {
        path,
        patch,
        comparison,
        expectedContent,
        decision,
        ...(decision === "rejected" ? { confirm: true } : {}),
      });
      request.assertCurrent();
      if (snapshot.key)
        publishHunkReview(
          hunkReviewCache,
          snapshot.key,
          result.decision,
          request,
        );
      if (mounted.current && current.current === submittedKey) {
        setConfirmation(null);
        onReviewed?.(result);
      }
    } catch (error) {
      if (mounted.current && current.current === submittedKey)
        setFailure({
          key: submittedKey,
          message:
            error instanceof Error
              ? error.message
              : "This hunk could not be reviewed. Refresh and try again.",
        });
    } finally {
      request.finish();
      pending.current = false;
      if (mounted.current)
        setBusy((owned) => (owned === submittedKey ? null : owned));
    }
  };
  if (!enabled) return null;
  const saving = busy === currentKey;
  return (
    <div
      className="text-fg2 flex min-w-0 flex-wrap items-center gap-1 text-xs"
      data-hunk-review-key={key}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={saving || accepted}
        title="Keep this change and mark it reviewed"
        onClick={() => void decide("accepted")}
      >
        <Check aria-hidden="true" className="size-3" />
        {accepted ? "Accepted" : "Accept"}
      </Button>
      <Button
        ref={rejectButton}
        type="button"
        variant="ghost"
        size="sm"
        disabled={saving}
        title="Discard only this uncommitted hunk"
        onClick={() => {
          setFailure(null);
          setConfirmation(currentKey);
        }}
      >
        <Undo2 aria-hidden="true" className="size-3" />
        Reject
      </Button>
      {!confirming && error && (
        <span role="alert" className="text-red-primary basis-full">
          {error}
        </span>
      )}
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !saving) setConfirmation(null);
        }}
      >
        <DialogContent
          showCloseButton={!saving}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelButton.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (current.current === currentKey) rejectButton.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Reject this hunk?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>
              Discard the selected uncommitted changes in{" "}
              <span className="text-fg1 break-all">{path}</span>.
            </DialogDescription>
            {error && (
              <p role="alert" className="text-red-primary text-xs">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              ref={cancelButton}
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive-secondary"
              disabled={saving}
              aria-busy={saving}
              onClick={() => void decide("rejected")}
            >
              Reject hunk
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});
