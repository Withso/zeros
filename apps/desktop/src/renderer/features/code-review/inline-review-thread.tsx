import { memo, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  MessageSquare,
  RotateCcw,
} from "lucide-react";
import { shellOpenUrl } from "@/renderer/platform/app";
import { Button, Tooltip } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { renderMarkdown } from "@/renderer/features/agent/markdown";
import { ReviewComposer } from "./review-composer";
import type { ReviewDraftStore } from "./review-draft-store";
import type { ReviewAnchorState } from "./review-anchors";
import {
  reviewRangeLabel,
  reviewThreadKey,
  type CodeReviewOperations,
  type CodeReviewThreadItem,
} from "./review-thread-model";

function actorKind(
  thread: CodeReviewThreadItem,
  kind: CodeReviewThreadItem["comments"][number]["author"]["kind"],
): string {
  if (thread.source === "check") return "Check";
  if (thread.source === "github" && kind === "integration") return "Bot";
  return kind === "agent"
    ? "Agent"
    : kind === "integration"
      ? "Integration"
      : "Human";
}

const ReviewCommentBody = memo(function ReviewCommentBody({
  body,
}: {
  body: string;
}) {
  const html = useMemo(() => renderMarkdown(body), [body]);
  return (
    <div
      data-review-comment-body
      className="zeros-agent-md min-w-0 break-words [&_.zeros-md-prose]:text-xs [&_.zeros-md-prose]:leading-relaxed [&_.zeros-md-prose>:first-child]:mt-0 [&_.zeros-md-prose>:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:text-xs"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        className="zeros-md-prose"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
});

export const InlineReviewThread = memo(function InlineReviewThread({
  thread,
  state = "current",
  operations,
  drafts,
  active,
  viewerActorId,
}: {
  thread: CodeReviewThreadItem;
  state?: ReviewAnchorState;
  operations: CodeReviewOperations;
  drafts: ReviewDraftStore;
  active: boolean;
  viewerActorId?: string;
}) {
  const [expandedResolved, setExpandedResolved] = useState(false);
  const draftKey = `reply:${reviewThreadKey(thread)}`;
  const [replying, setReplying] = useState(() => {
    const draft = drafts.getSnapshot(draftKey);
    return !!draft.body || draft.busy || !!draft.error;
  });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const historyFlight = useRef(false);
  const open = !thread.resolved || expandedResolved || replying;
  const first = thread.comments[0];
  const range = thread.anchorMissing
    ? "File discussion"
    : reviewRangeLabel(thread.anchor);
  const setResolved = () => {
    if (!active || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    void operations
      .setResolved(thread, !thread.resolved)
      .then(() => {
        setExpandedResolved(false);
        setReplying(false);
      })
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };
  return (
    <section
      data-review-thread={reviewThreadKey(thread)}
      data-review-anchor-state={state}
      aria-label={`${thread.source === "check" ? "Check annotation" : "Discussion"} on ${range}`}
      {...(!active ? { inert: "" } : {})}
      className="border-border2 bg-bg1 min-w-0 rounded-md border font-sans text-xs"
    >
      <div className="text-fg2 flex min-h-8 flex-wrap items-center gap-1.5 px-2 py-1">
        {thread.resolved ? (
          <Button
            variant="ghost"
            className="min-w-0 gap-1 px-0.5"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} resolved discussion`}
            onClick={() => setExpandedResolved(!open)}
          >
            <ChevronDown className={cn("size-3", !open && "-rotate-90")} />
            <Check className="size-3" /> Resolved
          </Button>
        ) : (
          <MessageSquare className="size-3 shrink-0" />
        )}
        {!open && first && (
          <span className="text-fg2 min-w-0 truncate">{first.author.name}</span>
        )}
        <span className="text-fg3 min-w-0 truncate">{range}</span>
        {thread.source === "github" && <span className="text-fg3">GitHub</span>}
        {thread.severity && (
          <span
            className={cn(
              "capitalize",
              thread.severity === "failure"
                ? "text-red-primary"
                : thread.severity === "warning"
                  ? "text-yellow-primary"
                  : "text-fg2",
            )}
          >
            {thread.severity}
          </span>
        )}
        {state !== "current" && (
          <span className="text-fg3">
            {state === "outdated"
              ? "Outdated · code changed"
              : "Original range unavailable"}
          </span>
        )}
        <div className="flex-1" />
        {thread.url && (
          <Tooltip
            label={
              thread.source === "github"
                ? "Open on GitHub"
                : "Open check source"
            }
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label={
                thread.source === "github"
                  ? "Open discussion on GitHub"
                  : "Open check source"
              }
              onClick={() => {
                void shellOpenUrl(thread.url!).catch((failure) =>
                  setError(String(failure)),
                );
              }}
            >
              <ExternalLink className="size-3" />
            </Button>
          </Tooltip>
        )}
        {thread.canResolve && (
          <Button
            variant="ghost"
            disabled={busy || !active}
            aria-busy={busy || undefined}
            onClick={setResolved}
          >
            {thread.resolved ? (
              <RotateCcw className="size-3" />
            ) : (
              <Check className="size-3" />
            )}
            {busy ? "Updating…" : thread.resolved ? "Reopen" : "Resolve"}
          </Button>
        )}
      </div>
      {open && (
        <div className="flex min-w-0 flex-col gap-2 px-2 pb-2">
          {state !== "current" && thread.anchor.context && (
            <details className="text-fg3">
              <summary className="cursor-pointer">Original code</summary>
              <pre className="bg-bg2 text-fg2 mt-1 rounded-sm p-2 font-mono text-xs break-words whitespace-pre-wrap">
                {thread.anchor.context}
              </pre>
            </details>
          )}
          {thread.comments.map((comment, index) => (
            <div
              key={comment.id}
              className={cn(
                "min-w-0",
                index > 0 && "border-border1 border-t pt-2",
              )}
            >
              <div className="mb-1 flex min-w-0 items-center gap-1.5">
                <span
                  className="text-fg1 truncate font-medium"
                  title={comment.author.name}
                >
                  {thread.source === "workspace" &&
                  comment.author.kind === "human" &&
                  comment.author.id === viewerActorId
                    ? "You"
                    : comment.author.name}
                </span>
                <span className="text-fg3">
                  {actorKind(thread, comment.author.kind)}
                  {comment.author.provider
                    ? ` · ${comment.author.provider}`
                    : ""}
                </span>
                {comment.createdAt > 0 && (
                  <time
                    dateTime={new Date(comment.createdAt).toISOString()}
                    className="text-fg3 ml-auto shrink-0"
                    title={new Date(comment.createdAt).toLocaleString()}
                  >
                    {new Date(comment.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                )}
              </div>
              <ReviewCommentBody body={comment.body} />
            </div>
          ))}
          {thread.source !== "workspace" && thread.truncated && (
            <p className="text-fg3">More replies are available on GitHub.</p>
          )}
          {thread.source === "workspace" &&
            thread.commentsComplete === false && (
              <div className="text-fg3 flex flex-wrap items-center gap-2">
                <span>
                  {thread.commentCount
                    ? `${thread.comments.length} of ${thread.commentCount} comments loaded.`
                    : "Some replies are not loaded yet."}
                </span>
                {thread.commentsCursor && operations.loadMoreComments && (
                  <Button
                    variant="ghost"
                    disabled={historyBusy || !active}
                    aria-busy={historyBusy || undefined}
                    onClick={() => {
                      if (historyFlight.current) return;
                      historyFlight.current = true;
                      setHistoryBusy(true);
                      setError(null);
                      void operations.loadMoreComments!(thread)
                        .catch((failure) =>
                          setError(
                            failure instanceof Error
                              ? failure.message
                              : String(failure),
                          ),
                        )
                        .finally(() => {
                          historyFlight.current = false;
                          setHistoryBusy(false);
                        });
                    }}
                  >
                    {historyBusy ? "Loading replies…" : "Load more replies"}
                  </Button>
                )}
              </div>
            )}
          {replying ? (
            <ReviewComposer
              store={drafts}
              draftKey={draftKey}
              label={`Reply to ${first?.author.name ?? "discussion"}`}
              submitLabel={
                thread.source === "github" ? "Post reply to PR" : "Reply"
              }
              active={active}
              onSubmit={(body, requestId) =>
                operations.reply(thread, body, requestId)
              }
              onCancel={() => setReplying(false)}
              onSubmitted={() => setReplying(false)}
            />
          ) : (
            thread.canReply && (
              <Button
                variant="ghost"
                className="text-fg2 self-start"
                disabled={!active}
                onClick={() => {
                  drafts.requestFocus(draftKey);
                  setReplying(true);
                }}
              >
                Reply
              </Button>
            )
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-red-primary px-2 pb-2 break-words">
          {error}
        </p>
      )}
    </section>
  );
});
