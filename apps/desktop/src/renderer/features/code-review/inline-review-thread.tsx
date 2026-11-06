import {
  memo,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleX,
  Info,
  MessageSquare,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { shellOpenUrl } from "@/renderer/platform/app";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Tooltip,
} from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { GithubIcon } from "@/renderer/shared/ui/github-icon";
import { initialsOf } from "@/renderer/shared/lib/initials";
import { renderMarkdown } from "@/renderer/features/agent/markdown";
import { AgentIcon } from "@/renderer/features/agent/agent-icon";
import {
  getTeamStoreState,
  subscribeOrganizationSnapshots,
} from "@/renderer/features/team/team-store";
import { ReviewComposer } from "./review-composer";
import type { ReviewDraftStore } from "./review-draft-store";
import type { ReviewAnchorState } from "./review-anchors";
import {
  reviewRangeLabel,
  reviewThreadKey,
  type CodeReviewOperations,
  type CodeReviewThreadComment,
  type CodeReviewThreadItem,
} from "./review-thread-model";

/** A non-person author's badge; people carry none (the Human label goes),
 *  and a check names its severity in that place instead. */
function actorKind(
  thread: CodeReviewThreadItem,
  kind: CodeReviewThreadComment["author"]["kind"],
): string | null {
  if (thread.source === "check") return null;
  if (thread.source === "github" && kind === "integration") return "Bot";
  return kind === "agent"
    ? "Agent"
    : kind === "integration"
      ? "Integration"
      : null;
}

const AGENT_MARKS = new Set(["claude", "codex", "cursor"]);

/** A check's severity icon fills the avatar slot in its colour. */
function SeverityIcon({ severity }: { severity: CodeReviewThreadItem["severity"] }) {
  const Icon =
    severity === "failure"
      ? CircleX
      : severity === "warning"
        ? TriangleAlert
        : Info;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center",
        severity === "failure"
          ? "text-red-primary"
          : severity === "warning"
            ? "text-yellow-primary"
            : "text-fg2",
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

/** People get a round photo or initials; an agent its mark on a rounded
 *  square; a review app its logo on a rounded square. Initials show until
 *  an image loads. */
function AuthorAvatar({
  name,
  kind,
  provider,
  avatarUrl,
}: {
  name: string;
  kind?: CodeReviewThreadComment["author"]["kind"];
  provider?: string;
  avatarUrl?: string | null;
}) {
  if (kind === "agent" && provider && AGENT_MARKS.has(provider))
    return (
      <span
        aria-hidden
        className="bg-sidebar-bg ring-border2 inline-flex size-5 shrink-0 items-center justify-center rounded-md ring-1 ring-inset"
      >
        <AgentIcon
          agentId={provider}
          iconUrl={null}
          size={provider === "codex" ? 14 : 13}
        />
      </span>
    );
  const square = kind === "integration";
  return (
    <Avatar
      size="xs"
      aria-hidden
      className={cn(square && "rounded-md")}
    >
      {avatarUrl ? (
        <AvatarImage
          src={avatarUrl}
          alt=""
          className={cn(square && "rounded-md")}
        />
      ) : null}
      <AvatarFallback
        className={cn("text-fg2 font-semibold", square && "rounded-md")}
      >
        {initialsOf(name)}
      </AvatarFallback>
    </Avatar>
  );
}

/** Whoever is signed in, for the avatar beside the reply field. A passive
 *  read: a thread must not start an account request. */
function useViewerIdentity(): { name: string; avatarUrl?: string | null } {
  const user = useSyncExternalStore(
    subscribeOrganizationSnapshots,
    () => getTeamStoreState().me?.user ?? null,
  );
  return {
    name: user?.displayName?.trim() || user?.email || "You",
    avatarUrl: user?.avatarUrl,
  };
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
      className="zeros-agent-md min-w-0 break-words mt-0.5 [&_.zeros-md-prose]:text-xs [&_.zeros-md-prose]:leading-5 [&_.zeros-md-prose>:first-child]:mt-0 [&_.zeros-md-prose>:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:text-xs"
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

/** A quiet line across the thread with its note in the middle. */
function ThreadDivider({ children }: { children: ReactNode }) {
  return (
    <div className="text-fg3 before:bg-border1 after:bg-border1 flex min-h-6 min-w-0 items-center gap-2.5 text-3xxs leading-4 before:h-px before:min-w-4 before:flex-1 after:h-px after:min-w-4 after:flex-1 [&>*]:shrink-0">
      {children}
    </div>
  );
}

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
  const viewer = useViewerIdentity();
  const replyAs = thread.replyAs === undefined ? viewer : thread.replyAs;
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
  const headIcon =
    thread.source === "github" ? (
      <GithubIcon className="text-fg3 size-3.5 shrink-0" />
    ) : (
      <MessageSquare className="text-fg3 size-3.5 shrink-0" />
    );
  const openButton = thread.url ? (
    <Tooltip
      label={
        thread.source === "github" ? "Open on GitHub" : "Open check source"
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
  ) : null;
  const errorLine = error && (
    <p
      role="alert"
      className="text-red-primary flex items-start gap-1.5 px-3 pb-3 text-3xxs leading-4 break-words"
    >
      <CircleX className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0">{error}</span>
    </p>
  );
  const commentCount = thread.commentCount ?? thread.comments.length;
  const meta = (comment: CodeReviewThreadComment) => (
    <>
      <span className="text-fg1 truncate font-medium" title={comment.author.name}>
        {thread.source === "workspace" &&
        comment.author.kind === "human" &&
        comment.author.id === viewerActorId
          ? "You"
          : comment.author.name}
      </span>
      {actorKind(thread, comment.author.kind) && (
        <Badge className="bg-bg2-highlight h-4.5 px-1.5 text-2xxs">
          {actorKind(thread, comment.author.kind)}
        </Badge>
      )}
    </>
  );
  const time = (comment: CodeReviewThreadComment) => {
    const at = new Date(comment.createdAt);
    // An out-of-range stored time would make toISOString throw during render.
    if (!(comment.createdAt > 0) || Number.isNaN(at.getTime())) return null;
    return (
      <time
        dateTime={at.toISOString()}
        className="text-fg3 shrink-0 text-3xxs leading-4"
        title={at.toLocaleString()}
      >
        {at.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })}
      </time>
    );
  };

  // A check annotation reads like one comment by the check: its severity
  // icon in the avatar slot, the check's name, a severity pill and the line.
  if (thread.source === "check")
    return (
      <section
        data-review-thread={reviewThreadKey(thread)}
        data-review-anchor-state={state}
        aria-label={`Check annotation on ${range}`}
        {...(!active ? { inert: "" } : {})}
        className="border-border2 bg-bg2 min-w-0 rounded-lg border font-sans text-xs leading-4.5"
      >
        <div className="flex min-w-0 flex-col gap-4 pt-3 pr-2 pb-3.5 pl-3">
          {thread.comments.map((comment) => (
            <article
              key={comment.id}
              className="grid min-w-0 grid-cols-[20px_minmax(0,1fr)] gap-x-2.5"
            >
              <SeverityIcon severity={thread.severity} />
              <div className="min-w-0">
                <div className="-mt-0.5 flex h-6 min-w-0 items-center gap-1.5">
                  {meta(comment)}
                  {thread.severity && (
                    <Badge
                      variant={
                        thread.severity === "failure"
                          ? "failure"
                          : thread.severity === "warning"
                            ? "warning"
                            : "neutral"
                      }
                      className="h-4.5 px-1.5 text-2xxs capitalize"
                    >
                      {thread.severity}
                    </Badge>
                  )}
                  <span className="text-fg3 min-w-0 truncate text-3xxs leading-4">
                    {range}
                  </span>
                  <div className="flex-1" />
                  {openButton}
                </div>
                <ReviewCommentBody body={comment.body} />
              </div>
            </article>
          ))}
        </div>
        {errorLine}
      </section>
    );

  return (
    <section
      data-review-thread={reviewThreadKey(thread)}
      data-review-anchor-state={state}
      aria-label={`Discussion on ${range}`}
      {...(!active ? { inert: "" } : {})}
      // A posted discussion sits on bg2 with a border2 edge, apart from the
      // code; its 36px head sits over a border2 rule while open. Folded, a
      // resolved one is a quieter row.
      className={cn(
        "border-border2 min-w-0 rounded-lg border font-sans text-xs leading-4.5",
        open ? "bg-bg2" : "bg-bg2/55",
      )}
    >
      <div
        className={cn(
          "text-fg2 flex min-h-9 min-w-0 items-center gap-2 py-1 pr-2 pl-3 text-3xxs leading-4 font-medium",
          open && "border-border2 border-b",
        )}
      >
        {thread.resolved ? (
          <Button
            variant="ghost"
            size="compact"
            className="-ml-1.5 min-w-0 shrink gap-2 pr-2 pl-1.5 font-normal"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} resolved discussion`}
            onClick={() => setExpandedResolved(!open)}
          >
            <ChevronDown className={cn("text-fg3", !open && "-rotate-90")} />
            <Badge variant="success">Resolved</Badge>
            {open || !first ? (
              <span className="text-fg3 min-w-0 truncate">{range}</span>
            ) : (
              <>
                <span className="text-fg2 min-w-0 truncate">
                  {first.author.name}
                </span>
                <span className="text-fg3 min-w-0 truncate">
                  {commentCount === 1 ? "1 comment" : `${commentCount} comments`}
                </span>
              </>
            )}
          </Button>
        ) : (
          <>
            {headIcon}
            <span className="text-fg2 min-w-0 truncate">{range}</span>
          </>
        )}
        {open && state !== "current" && (
          <Badge
            className="bg-bg2-highlight"
            title={
              state === "outdated" ? "Code changed since this comment" : undefined
            }
          >
            {state === "outdated" ? "Outdated" : "Original range unavailable"}
          </Badge>
        )}
        <div className="flex-1" />
        {openButton}
        {thread.canResolve && (
          <Button
            size="compact"
            loading={busy}
            disabled={!active}
            onClick={setResolved}
          >
            {!busy && (thread.resolved ? <RotateCcw /> : <Check />)}
            {busy ? "Updating…" : thread.resolved ? "Reopen" : "Resolve"}
          </Button>
        )}
      </div>
      {open && (
        <div className="flex min-w-0 flex-col gap-4 px-3 py-3.5">
          {state !== "current" && thread.anchor.context && (
            <details className="group min-w-0">
              <summary className="text-fg2 hover:bg-bg2-highlight hover:text-fg1 -ml-1.5 inline-flex h-6 cursor-default list-none items-center gap-1 rounded-md pr-2 pl-1 text-3xxs leading-4 font-medium [&::-webkit-details-marker]:hidden">
                <ChevronRight className="text-fg3 size-3 group-open:rotate-90" />
                Original code
              </summary>
              <div className="border-border1 bg-sidebar-bg mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] overflow-hidden rounded-md border font-mono text-3xxs leading-5">
                {thread.anchor.context.split("\n").map((line, index) => (
                  <div key={index} className="contents">
                    <span className="text-fg3 py-px pr-2.5 pl-3 text-right tabular-nums select-none first:pt-1">
                      {thread.anchor.startLine + index}
                    </span>
                    <code className="text-fg1 py-px pr-3 pl-1 break-words whitespace-pre-wrap">
                      {line}
                    </code>
                  </div>
                ))}
              </div>
            </details>
          )}
          {thread.comments.map((comment) => (
            <article
              key={comment.id}
              className="grid min-w-0 grid-cols-[20px_minmax(0,1fr)] gap-x-2.5"
            >
              <AuthorAvatar
                name={comment.author.name}
                kind={comment.author.kind}
                provider={comment.author.provider}
                avatarUrl={comment.author.avatarUrl}
              />
              <div className="min-w-0">
                <div className="flex h-5 min-w-0 items-center gap-1.5">
                  {meta(comment)}
                  {time(comment)}
                </div>
                <ReviewCommentBody body={comment.body} />
              </div>
            </article>
          ))}
          {thread.source !== "workspace" && thread.truncated && (
            <ThreadDivider>More replies are available on GitHub</ThreadDivider>
          )}
          {thread.source === "workspace" &&
            thread.commentsComplete === false && (
              <ThreadDivider>
                <span>
                  {thread.commentCount
                    ? `${thread.comments.length} of ${thread.commentCount} comments loaded`
                    : "Some replies are not loaded yet"}
                </span>
                {thread.commentsCursor && operations.loadMoreComments && (
                  <Button
                    size="compact"
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
              </ThreadDivider>
            )}
        </div>
      )}
      {open && (replying || thread.canReply) && (
        // Reply is a field in the composer look beside the avatar of whoever
        // it posts as; focusing it opens the reply box in place.
        <div className="grid min-w-0 grid-cols-[20px_minmax(0,1fr)] items-start gap-x-2.5 px-3 pb-3">
          <span className="mt-1.5">
            {replyAs ? <AuthorAvatar name={replyAs.name} avatarUrl={replyAs.avatarUrl} /> : null}
          </span>
          {replying ? (
            <ReviewComposer
              store={drafts}
              draftKey={draftKey}
              label={`Reply to ${first?.author.name ?? "discussion"}`}
              showLabel={false}
              variant="reply"
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
            <Button
              aria-label="Reply"
              disabled={!active}
              className="border-border2 bg-sidebar-bg text-fg3 hover:border-border3 hover:bg-sidebar-bg hover:text-fg2 h-8 w-full min-w-0 justify-start px-2.5 font-normal"
              onClick={() => {
                drafts.requestFocus(draftKey);
                setReplying(true);
              }}
            >
              Reply…
            </Button>
          )}
        </div>
      )}
      {errorLine}
    </section>
  );
});
