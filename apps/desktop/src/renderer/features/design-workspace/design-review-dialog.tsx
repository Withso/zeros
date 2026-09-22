import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  FileCode2,
  GitBranch,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type {
  DesignReviewScope,
  DesignProposalReview,
  DesignReviewFile,
  DesignReviewProposal,
} from "@zeros/protocol/design-review";
import {
  Button,
  toast,
  Input,
  Dialog,
  DialogContent,
  DialogBody,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/primitives";
import { useCachedRead } from "../../state/use-cached-read";
import {
  designReviewCache,
  designReviewDetailCache,
  designReviewEvidenceCache,
  invalidateDesignReviewCache,
} from "../../state/read-caches";
import { useGitRefreshKey } from "../../shell/use-git-refresh-key";
import {
  designReviewOperation,
  resolveDesignProposalReview,
} from "../../platform/bridge/design-review-bridge";
import { invalidateDesignWorkspaceSnapshot, waitForPendingDesignEdits } from "./state/design-workspace-cache";
import {
  DESIGN_REVIEW_MAX_AGE,
  designReviewKey,
  fetchDesignReview,
  fetchDesignReviewDetail,
  warmDesignReview,
  warmDesignReviewDetail,
  fetchDesignReviewEvidence,
} from "./state/design-review-cache";
import "./design-review-dialog.css";

const scopes: Array<[DesignReviewScope, string]> = [
  ["all", "All changes"],
  ["uncommitted", "Uncommitted"],
  ["staged", "Staged"],
  ["unstaged", "Unstaged"],
  ["proposals", "Agent proposals"],
];
function proposalStatusLabel(proposal: DesignReviewProposal): string {
  if (proposal.review?.decision === "accept") return "Accepted";
  if (proposal.review?.decision === "reject") return "Rejected";
  switch (proposal.status) {
    case "proposed":
      return "Awaiting review";
    case "committed":
      return "Applied by agent";
    case "rejected":
      return "Rejected by agent";
    case "indeterminate":
      return "Outcome needs inspection";
  }
}
type Selection =
  | { kind: "file"; file: DesignReviewFile }
  | { kind: "proposal"; proposal: DesignReviewProposal };
interface Props {
  workspaceId: string;
  folder: string | null;
  active: boolean;
  queueAction: <T>(action: () => Promise<T>) => Promise<T>;
}

export function DesignReviewDialog({
  workspaceId,
  folder,
  active,
  queueAction,
}: Props) {
  const [open, setOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [scope, setScope] = useState<DesignReviewScope>("uncommitted");
  const [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [message, setMessage] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const busy = useRef(false);
  const visible = active && open;
  const reviewVisible = visible;
  // The shared change bus invalidates these exact-key caches. It owns the one
  // bridge subscription; closing/retaining this dialog introduces no polling.
  useGitRefreshKey(folder, workspaceId, visible);
  const key = designReviewKey(workspaceId, scope, offset);
  const read = useCachedRead(
    designReviewCache,
    reviewVisible ? key : null,
    fetchDesignReview,
    { maxAgeMs: DESIGN_REVIEW_MAX_AGE },
  );
  const snapshot = read.data;
  const detailKey =
    snapshot && selection
      ? JSON.stringify(
          selection.kind === "file"
            ? [workspaceId, snapshot.directoryId, scope, selection.file.path, selection.file.oldPath ?? ""]
            : [
                workspaceId,
                snapshot.directoryId,
                "proposal",
                selection.proposal.actorId,
                selection.proposal.id,
                selection.proposal.signature,
              ],
        )
      : null;
  const detail = useCachedRead(
    designReviewDetailCache,
    reviewVisible ? detailKey : null,
    fetchDesignReviewDetail,
    { maxAgeMs: DESIGN_REVIEW_MAX_AGE },
  );
  const proposalReview =
    detail.data && "proposal" in detail.data
      ? (detail.data as DesignProposalReview)
      : null;
  const evidenceKey =
    snapshot && proposalReview?.evidence
      ? JSON.stringify([
          workspaceId,
          snapshot.directoryId,
          proposalReview.proposal.actorId,
          proposalReview.proposal.id,
          proposalReview.proposal.signature,
          proposalReview.evidence.id,
        ])
      : null;
  const evidence = useCachedRead(
    designReviewEvidenceCache,
    reviewVisible ? evidenceKey : null,
    fetchDesignReviewEvidence,
    { maxAgeMs: DESIGN_REVIEW_MAX_AGE },
  );
  const blocked =
    preparing ||
    busy.current ||
    action !== null ||
    !snapshot ||
    read.loading ||
    read.refreshing ||
    !!read.error ||
    snapshot.conflict;

  const reviewError = read.error?.message ?? detail.error?.message ?? evidence.error?.message;
  useEffect(() => {
    if (!reviewVisible) return;
    const id = `design-review-read:${workspaceId}`;
    if (reviewError || snapshot?.conflict) toast.error("Design review needs attention", {
      id, duration: Infinity,
      description: reviewError ?? "Resolve the Git conflict before staging or committing Design changes.",
      action: { label: "Refresh", onClick: () => invalidateDesignReviewCache(workspaceId) },
    });
    else toast.dismiss(id);
    return () => { toast.dismiss(id); };
  }, [reviewError, snapshot?.conflict, reviewVisible, workspaceId]);
  const refresh = () => {
    invalidateDesignReviewCache(workspaceId);
    setFeedback(null);
  };
  const run = (
    label: string,
    task: () => Promise<unknown>,
    success: string,
    onSuccess?: (result: unknown) => void,
  ) => {
    if (busy.current || !active) return;
    busy.current = true;
    setAction(label);
    setFeedback(null);
    void queueAction(task)
      .then(
        (result) => {
          onSuccess?.(result);
          toast.dismiss(`design-review-action:${workspaceId}`);
          setFeedback({ error: false, text: success });
          invalidateDesignWorkspaceSnapshot(workspaceId);
        },
        (error: unknown) => {
          toast.error("Design review needs attention", { id: `design-review-action:${workspaceId}`, description: error instanceof Error ? error.message : "Refresh review before trying again.", duration: Infinity });
        },
      )
      .finally(() => {
        busy.current = false;
        setAction(null);
        invalidateDesignReviewCache(workspaceId);
      });
  };
  const checkpoint = (kind: "stage" | "unstage" | "commit") => {
    if (blocked || !snapshot) return;
    const reviewed = snapshot;
    run(
      kind,
      () => designReviewOperation(`design.${kind}`, {
          workspaceId,
          directoryId: reviewed.directoryId,
          ...(kind === "commit"
            ? {
                message: message.trim() || "Commit Design checkpoint",
                indexFingerprint: reviewed.indexFingerprint,
              }
            : {}),
        }),
      kind === "stage"
        ? "Design changes staged."
        : kind === "unstage"
          ? "Design changes unstaged."
          : "Staged Design changes committed.",
      kind === "commit" ? () => setMessage("") : undefined,
    );
  };
  const decide = (decision: "accept" | "reject") => {
    if (
      !snapshot ||
      !proposalReview ||
      detail.loading ||
      detail.refreshing ||
      detail.error
    )
      return;
    const proposal = proposalReview.proposal;
    run(
      decision,
      () =>
        resolveDesignProposalReview(
          workspaceId,
          snapshot.directoryId,
          proposal,
          decision,
        ),
      decision === "accept"
        ? "Proposal applied. Review the changes before staging."
        : "Proposal rejected.",
    );
  };
  const warmDetail = (next: Selection) => {
    if (!snapshot) return;
    const nextKey = JSON.stringify(
      next.kind === "file"
        ? [workspaceId, snapshot.directoryId, scope, next.file.path, next.file.oldPath ?? ""]
        : [
            workspaceId,
            snapshot.directoryId,
            "proposal",
            next.proposal.actorId,
            next.proposal.id,
            next.proposal.signature,
          ],
    );
    warmDesignReviewDetail(nextKey);
  };

  return (
    <Dialog
      open={visible}
      onOpenChange={(next) => {
        if (next) {
          // Blur synchronously submits focused inspector/inline text input.
          // The dialog paints immediately while queued edits settle.
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          setPreparing(true);
          void queueAction(async () => { await waitForPendingDesignEdits(workspaceId); invalidateDesignReviewCache(workspaceId); })
            .catch((error: unknown) => toast.error("Couldn't prepare Design review", { description: error instanceof Error ? error.message : "Refresh review." }))
            .finally(() => setPreparing(false));
        }
        setOpen(next);
        if (!next) {
          setSelection(null);
          setFeedback(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={!active}
          aria-label="Review Design changes"
          onPointerEnter={() => active && warmDesignReview(workspaceId)}
          onFocus={() => active && warmDesignReview(workspaceId)}
        >
          <GitBranch />
        </Button>
      </DialogTrigger>
      <DialogContent
        className="design-review-dialog"
        data-design-review=""
      >
        <DialogHeader>
          <DialogTitle>Review Design changes</DialogTitle>
          <DialogDescription className="sr-only">
            Inspect changes and agent proposals. Stage Design changes and commit
            the staged snapshot.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="design-review-content">
          <nav className="design-review-sidebar" aria-label="Design pages">
            <h2>Design</h2>
            <Button
              variant="ghost"
              aria-current="page"
              className="design-review-owner"
              onClick={() => {
                setSelection(null);
                setOffset(0);
              }}
            >
              <FileCode2 />
              <span>Current canvas</span>
            </Button>
            <p className="design-review-caption">{snapshot?.directory ?? "Design folder"}</p>
          </nav>
          <section className="design-review-main" aria-label="Design changes">
            <header className="design-review-header">
              {selection ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Back to changes"
                  onClick={() => setSelection(null)}
                >
                  <ArrowLeft />
                </Button>
              ) : null}
              <h2>
                {selection
                  ? selection.kind === "file"
                    ? selection.file.path.split("/").at(-1)
                    : "Review proposal"
                  : "Changes"}
              </h2>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh Design review"
                onClick={refresh}
                disabled={action !== null}
              >
                <RefreshCw />
              </Button>
            </header>
            {!selection ? (
              <div className="design-review-filter">
                <Select
                  value={scope}
                  onValueChange={(value) => {
                    setScope(value as DesignReviewScope);
                    setOffset(0);
                    setFeedback(null);
                  }}
                >
                  <SelectTrigger className="h-8" aria-label="Design change scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {scopes.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                        {snapshot ? ` (${snapshot.counts[value]})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div
              className="design-review-body"
              aria-busy={read.loading || detail.loading}
            >


              {!snapshot && !read.error ? (
                <p role="status" className="design-review-empty">
                  Loading review…
                </p>
              ) : null}
              {selection ? (
                <>

                  {!detail.data && !detail.error ? (
                    <p role="status" className="design-review-empty">
                      Loading change…
                    </p>
                  ) : null}
                  {proposalReview ? (
                    <div className="design-review-proposal">
                      <h3>{proposalReview.proposal.intent}</h3>
                      <p className="design-review-caption">
                        Agent · {proposalReview.proposal.actorId}
                      </p>
                      <p className="design-review-caption">
                        {new Date(
                          proposalReview.proposal.createdAt,
                        ).toLocaleString()}{" "}
                        · {proposalStatusLabel(proposalReview.proposal)}
                      </p>
                      {proposalReview.proposal.review ? (
                        <p>
                          <Check className="design-review-inline-icon" />
                          {proposalReview.proposal.review.decision === "accept"
                            ? "Accepted"
                            : "Rejected"}{" "}
                          in Design mode
                        </p>
                      ) : null}
                      {proposalReview.reason ? (
                        <p role="status" className="design-review-notice">
                          {proposalReview.reason}
                        </p>
                      ) : (
                        <p className="design-review-caption">
                          Validated against the current source. Accept applies
                          this proposal; staging remains separate.
                        </p>
                      )}
                      {evidence.data ? (
                        <section
                          aria-label="Captured proposal preview"
                          className="design-review-evidence"
                        >
                          <p className="design-review-caption">
                            Saved preview · {evidence.data.viewport.width} ×{" "}
                            {evidence.data.viewport.height}
                            {proposalReview.currentRevision &&
                            evidence.data.baseRevision !==
                              proposalReview.currentRevision
                              ? " · Source has changed since this capture"
                              : ""}
                          </p>
                          <div className="design-review-images">
                            <figure>
                              <figcaption>Before</figcaption>
                              <img
                                alt="Design before proposal"
                                src={`data:image/png;base64,${evidence.data.before}`}
                              />
                            </figure>
                            <figure>
                              <figcaption>Proposed</figcaption>
                              <img
                                alt="Design with proposal"
                                src={`data:image/png;base64,${evidence.data.after}`}
                              />
                            </figure>
                          </div>
                        </section>
                      ) : null}

                      {proposalReview.applicable &&
                      proposalReview.captureAvailable ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={
                            action !== null || detail.refreshing || !!detail.error
                          }
                          onClick={() =>
                            run(
                              "capture",
                              () =>
                                designReviewOperation("design.review.capture", {
                                  workspaceId,
                                  directoryId: snapshot!.directoryId,
                                  actorId: proposalReview.proposal.actorId,
                                  requestId: proposalReview.proposal.id,
                                  signature: proposalReview.proposal.signature,
                                }),
                              "Preview saved for this proposal.",
                            )
                          }
                        >
                          {action === "capture"
                            ? "Capturing…"
                            : evidence.data
                              ? "Refresh preview"
                              : "Capture preview"}
                        </Button>
                      ) : null}
                      <details>
                        <summary>
                          {proposalReview.operations.length} proposed operations
                        </summary>
                        <ul>
                          {proposalReview.operations.map((operation, index) => (
                            <li key={index}>
                              {operation.type}
                              {operation.nodeId ? ` · ${operation.nodeId}` : ""}
                            </li>
                          ))}
                        </ul>
                      </details>
                      {proposalReview.proposal.status === "proposed" ? (
                        <div className="design-review-decisions">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={
                              action !== null ||
                              detail.refreshing ||
                              !!detail.error
                            }
                            onClick={() => decide("reject")}
                          >
                            Reject proposal
                          </Button>
                          <Button
                            size="sm"
                            disabled={
                              !proposalReview.applicable ||
                              action !== null ||
                              detail.refreshing ||
                              !!detail.error
                            }
                            onClick={() => decide("accept")}
                          >
                            Accept proposal
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {detail.data?.truncated ? (
                    <p className="design-review-notice">
                      This change is too large for a complete inline diff. Inspect
                      its source before accepting or committing.
                    </p>
                  ) : null}
                  {detail.data &&
                  "binary" in detail.data &&
                  detail.data.binary ? (
                    <p className="design-review-notice">
                      Binary file changed. A text diff is unavailable.
                    </p>
                  ) : null}
                  {detail.data?.patch ? (
                    <pre
                      className="design-review-patch"
                      tabIndex={0}
                      aria-label="Design source diff"
                    >
                      {detail.data.patch}
                    </pre>
                  ) : null}
                  {detail.data &&
                  !proposalReview &&
                  !detail.data.patch &&
                  !detail.data.truncated &&
                  !("binary" in detail.data && detail.data.binary) ? (
                    <p className="design-review-empty">
                      This file no longer has changes in this comparison.
                    </p>
                  ) : null}
                </>
              ) : snapshot ? (
                <>
                  {snapshot.files.map((file) => (
                    <Button
                      key={file.path}
                      variant="ghost"
                      className="design-review-row"
                      onPointerEnter={() => warmDetail({ kind: "file", file })}
                      onFocus={() => warmDetail({ kind: "file", file })}
                      onClick={() => setSelection({ kind: "file", file })}
                    >
                      <FileCode2 />
                      <span className="design-review-row-name">
                        {file.path.startsWith(`${snapshot.directory}/`)
                          ? file.path.slice(snapshot.directory.length + 1)
                          : file.path}
                      </span>
                      <span className="design-review-caption">{file.status}</span>
                      {!file.binary &&
                      (file.additions > 0 || file.deletions > 0) ? (
                        <span className="design-review-stats">
                          +{file.additions} −{file.deletions}
                        </span>
                      ) : null}
                    </Button>
                  ))}
                  {snapshot.proposals.map((proposal) => (
                    <Button
                      key={`${proposal.actorId}:${proposal.id}`}
                      variant="ghost"
                      className="design-review-row"
                      onPointerEnter={() =>
                        warmDetail({ kind: "proposal", proposal })
                      }
                      onFocus={() => warmDetail({ kind: "proposal", proposal })}
                      onClick={() => setSelection({ kind: "proposal", proposal })}
                    >
                      <Sparkles />
                      <span className="design-review-row-name">
                        {proposal.intent}
                      </span>
                      <span className="design-review-caption">
                        {proposalStatusLabel(proposal)}
                      </span>
                    </Button>
                  ))}
                  {snapshot.files.length === 0 &&
                  snapshot.proposals.length === 0 ? (
                    <p className="design-review-empty">
                      {scope === "proposals"
                        ? "No agent proposals to review."
                        : "No changes in this comparison."}
                    </p>
                  ) : null}
                  {offset > 0 || snapshot.nextOffset !== null ? (
                    <div className="design-review-pagination">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={offset === 0}
                        onClick={() => setOffset(Math.max(0, offset - 64))}
                      >
                        Previous
                      </Button>
                      <span className="design-review-caption">
                        {offset + 1}–
                        {offset +
                          snapshot.files.length +
                          snapshot.proposals.length}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={snapshot.nextOffset === null}
                        onClick={() => setOffset(snapshot.nextOffset!)}
                      >
                        Next
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </section>
        </DialogBody>
        <DialogFooter className="design-review-footer items-stretch">
          {feedback ? (
            <p
              role={feedback.error ? "alert" : "status"}
              className={
                feedback.error
                  ? "design-review-error"
                  : "design-review-caption"
              }
            >
              {feedback.text}
            </p>
          ) : null}
          <div className="design-review-stage-actions">
            <span className="design-review-caption">
              {snapshot
                ? `${snapshot.counts.staged} staged · ${snapshot.counts.unstaged} unstaged`
                : "Design checkpoint"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={blocked || !snapshot?.counts.staged}
              aria-label="Unstage Design changes"
              onClick={() => checkpoint("unstage")}
            >
              Unstage
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={blocked || !snapshot?.counts.unstaged}
              aria-label="Stage Design changes"
              onClick={() => checkpoint("stage")}
            >
              {action === "stage" ? "Staging…" : "Stage Design"}
            </Button>
          </div>
          <Input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Commit message (optional)"
            aria-label="Design commit message"
            maxLength={2000}
            disabled={action !== null}
          />
          <Button
            className="w-full"
            disabled={blocked || !snapshot?.counts.staged}
            aria-label="Commit staged Design changes"
            onClick={() => checkpoint("commit")}
          >
            {action === "commit" ? "Committing…" : "Commit staged Design"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
