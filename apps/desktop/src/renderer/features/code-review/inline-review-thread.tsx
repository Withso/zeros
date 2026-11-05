import { memo, useMemo, useRef, useState } from "react";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { ArrowUpRight, ChevronDown, MessageSquare } from "lucide-react";
import { shellOpenUrl } from "@/renderer/platform/app";
import { Badge, Button, Tooltip } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { initialsOf } from "@/renderer/shared/lib/initials";
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

/** A non-person author's badge; people carry none (the Human label goes). */
function actorKind(
  thread: CodeReviewThreadItem,
  kind: CodeReviewThreadItem["comments"][number]["author"]["kind"],
): string | null {
  if (thread.source === "check") return "Check";
  if (thread.source === "github" && kind === "integration") return "Bot";
  return kind === "agent"
    ? "Agent"
    : kind === "integration"
      ? "Integration"
      : null;
}

/** A round initials avatar beside each author. */
function AuthorAvatar({ name }: { name: string }) {
  const initials = initialsOf(name);
  return (
    <span
      aria-hidden
      className="bg-bg2-hover text-fg2 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-2xxs leading-4 font-medium"
    >
      {initials}
    </span>
  );
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
      // A posted discussion sits on bg2 with a border2 edge, apart from the
      // code; its 36px head sits over a border2 rule while open.
      className="border-border2 bg-bg2 min-w-0 rounded-lg border font-sans text-xs leading-4.5"
    >
      <div
        className={cn(
          "text-fg2 flex min-h-9 flex-wrap items-center gap-2 px-3 py-1",
          open && "border-border2 border-b",
        )}
      >
        {thread.resolved ? (
          <Button
            variant="ghost"
            size="compact"
            className="-ml-1.5 min-w-0 gap-1.5 px-1.5"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} resolved discussion`}
            onClick={() => setExpandedResolved(!open)}
          >
            <ChevronDown className={cn("size-3", !open && "-rotate-90")} />
            <Badge variant="success">Resolved</Badge>
          </Button>
        ) : (
          <MessageSquare className="text-fg3 size-3.5 shrink-0" />
        )}
        {!open && first && (
          <span className="text-fg2 min-w-0 truncate">
            {first.author.name}
            {thread.comments.length > 1 ? ` · ${thread.comments.length}` : ""}
          </span>
        )}
        <span className="text-fg2 min-w-0 truncate">{range}</span>
        {thread.source === "github" && <span className="text-fg3">GitHub</span>}
        {thread.severity && (
          <Badge
            variant={
              thread.severity === "failure"
                ? "failure"
                : thread.severity === "warning"
                  ? "warning"
                  : "neutral"
            }
            className="capitalize"
          >
            {thread.severity}
          </Badge>
        )}
        {state !== "current" && (
          <Badge variant="outline">
            {state === "outdated" ? "Outdated" : "Original range unavailable"}
          </Badge>
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
            <IconButton
              size="compact"
              label={
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
              <ArrowUpRight />
            </IconButton>
          </Tooltip>
        )}
        {thread.canResolve && (
          <Button
            size="compact"
            loading={busy}
            disabled={!active}
            onClick={setResolved}
          >
            {busy ? "Updating…" : thread.resolved ? "Reopen" : "Resolve"}
          </Button>
        )}
      </div>
      {open && (
        <div className="flex min-w-0 flex-col gap-4 p-3">
          {state !== "current" && thread.anchor.context && (
            <details className="text-fg3">
              <summary className="cursor-pointer">Original code</summary>
              <pre className="bg-bg2 text-fg2 mt-1 rounded-sm p-2 font-mono text-xs break-words whitespace-pre-wrap">
                {thread.anchor.context}
              </pre>
            </details>
          )}
          {thread.comments.map((comment) => (
            <div key={comment.id} className="min-w-0">
              <div className="mb-1 flex min-w-0 items-center gap-2">
                <AuthorAvatar name={comment.author.name} />
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
                {actorKind(thread, comment.author.kind) && (
                  <Badge>
                    {actorKind(thread, comment.author.kind)}
                    {comment.author.provider
                      ? ` · ${comment.author.provider}`
                      : ""}
                  </Badge>
                )}
                {comment.createdAt > 0 && (
                  <time
                    dateTime={new Date(comment.createdAt).toISOString()}
                    className="text-fg3 shrink-0"
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
              showLabel={false}
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
