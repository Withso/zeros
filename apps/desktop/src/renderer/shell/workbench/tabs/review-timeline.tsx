// ──────────────────────────────────────────────────────────
// ReviewTimelineSection — the Review tab's Reviews sub-tab
// ──────────────────────────────────────────────────────────
//
// One chronological activity stream (composeTimeline): opened → commits →
// reviews/comments → merged/closed, drawn on a connector rail with avatars.
// Review + comment bodies render as sanitised markdown cards with "Add to
// chat" (quoted context lands in the active composer — the user adds
// instructions and sends). The composer at the bottom posts optimistically:
// the comment appears instantly, reconciles against GitHub in the background,
// and rolls back (keeping the draft) if the post fails.

import React, { useMemo, useRef, useState } from "react";
import {
  GitCommit,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  MessageSquarePlus,
} from "lucide-react";

import type { PR, PrCommitSummary } from "../../../platform/git";
import {
  Button,
  Kbd,
  Textarea,
  Tooltip,
} from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { renderMarkdown } from "@/renderer/features/agent/markdown";
import { buildReviewCommentContext } from "../../pr/pr-action-prompts";
import { humanGitError, type ReviewTimelineEntry } from "./review-data";
import {
  composeTimeline,
  relTime,
  type ReviewTimelineEvent,
} from "./review-model";
import {
  AuthorAvatar,
  Centered,
  ErrorCallout,
} from "./review-shared-components";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { useScrollMemoryRef } from "../../scroll-memory";

export function ReviewTimelineSection({
  pr,
  prNumber,
  commits,
  timeline,
  loading,
  error,
  scrollKey,
  onAddToChat,
  onPostComment,
  onRetry,
}: {
  pr: PR | null;
  prNumber: number;
  commits: PrCommitSummary[] | null;
  timeline: ReviewTimelineEntry[] | null;
  loading: boolean;
  error: string | null;
  /** Exact workspace+PR owner for the nested timeline scroller. */
  scrollKey: string;
  onAddToChat: (text: string) => void;
  onPostComment: (body: string) => Promise<void>;
  onRetry: () => void;
}) {
  const timelineScrollRef = useScrollMemoryRef(scrollKey);
  const events = useMemo(
    () =>
      composeTimeline({
        pr,
        commits: commits ?? [],
        items: timeline ?? [],
      }),
    [pr, commits, timeline],
  );
  const optimisticIds = useMemo(
    () =>
      new Set((timeline ?? []).filter((t) => t.optimistic).map((t) => t.id)),
    [timeline],
  );

  const body =
    events.length === 0 ? (
      loading && !timeline ? (
        <div className="min-h-24" aria-busy="true" />
      ) : (
        <Centered>
          No activity yet. Reviews and comments land here live.
        </Centered>
      )
    ) : (
      <ol className="m-0 flex list-none flex-col p-3 pl-4">
        {events.map((e, i) => (
          <TimelineRow
            key={eventKey(e, i)}
            event={e}
            last={i === events.length - 1}
            prNumber={prNumber}
            optimistic={
              (e.kind === "comment" || e.kind === "review") &&
              optimisticIds.has(e.item.id)
            }
            onAddToChat={onAddToChat}
          />
        ))}
      </ol>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={timelineScrollRef} className="min-h-0 flex-1 overflow-auto">
        {error && (
          <div className="p-3 pb-0">
            <ErrorCallout text={error} onRetry={onRetry} />
          </div>
        )}
        {body}
      </div>
      <CommentComposer onPost={onPostComment} />
    </div>
  );
}

function eventKey(e: ReviewTimelineEvent, i: number): string {
  switch (e.kind) {
    case "commit":
      return `commit-${e.commit.sha}`;
    case "review":
    case "comment":
      return `${e.kind}-${e.item.id}`;
    default:
      return `${e.kind}-${i}`;
  }
}

// ── rows ─────────────────────────────────────────────────────

/** Gutter cell (icon or avatar) + connector line + content. */
function TimelineRow({
  event,
  last,
  prNumber,
  optimistic,
  onAddToChat,
}: {
  event: ReviewTimelineEvent;
  last: boolean;
  prNumber: number;
  optimistic: boolean;
  onAddToChat: (text: string) => void;
}) {
  const isCard = event.kind === "review" || event.kind === "comment";
  return (
    <li className="relative flex gap-2.5 pb-1">
      {/* rail */}
      <div className="flex w-6 shrink-0 flex-col items-center">
        <div className="flex h-6 shrink-0 items-center justify-center">
          <EventGlyph event={event} />
        </div>
        {!last && <div className="bg-border2 w-px flex-1" />}
      </div>
      <div className={cn("min-w-0 flex-1 pb-2", isCard && "pb-3")}>
        <EventBody
          event={event}
          prNumber={prNumber}
          optimistic={optimistic}
          onAddToChat={onAddToChat}
        />
      </div>
    </li>
  );
}

function EventGlyph({ event }: { event: ReviewTimelineEvent }) {
  switch (event.kind) {
    case "opened":
      return <GitPullRequestArrow className="text-green-primary size-3.5" />;
    case "commit":
      return <GitCommit className="text-fg2 size-3.5" />;
    case "merged":
      return <GitMerge className="text-violet-primary size-3.5" />;
    case "closed":
      return <GitPullRequestClosed className="text-red-primary size-3.5" />;
    case "review":
    case "comment":
      return (
        <AuthorAvatar
          login={event.item.author}
          avatarUrl={event.item.authorAvatarUrl}
        />
      );
  }
}

function EventBody({
  event,
  prNumber,
  optimistic,
  onAddToChat,
}: {
  event: ReviewTimelineEvent;
  prNumber: number;
  optimistic: boolean;
  onAddToChat: (text: string) => void;
}) {
  switch (event.kind) {
    case "opened":
      return (
        <EventLine
          author={event.author}
          verb="opened this pull request"
          at={event.at}
        />
      );
    case "commit":
      return (
        <div className="flex h-6 min-w-0 items-center gap-1.5 text-xs">
          <span className="text-fg1 shrink-0 font-medium">
            {event.commit.authorLogin ?? event.commit.authorName}
          </span>
          <span className="text-fg2 shrink-0">committed</span>
          <span className="text-fg1 min-w-0 truncate">
            {event.commit.message.split("\n")[0]}
          </span>
          <span className="text-muted-fg shrink-0">{relTime(event.at)}</span>
        </div>
      );
    case "merged":
      return (
        <EventLine verb="Pull request merged" at={event.at} tone="merged" />
      );
    case "closed":
      return (
        <EventLine verb="Pull request closed" at={event.at} tone="closed" />
      );
    case "review":
    case "comment":
      return (
        <TimelineCard
          item={event.item}
          prNumber={prNumber}
          optimistic={optimistic}
          onAddToChat={onAddToChat}
        />
      );
  }
}

function EventLine({
  author,
  verb,
  at,
  tone,
}: {
  author?: string;
  verb: string;
  at: number;
  tone?: "merged" | "closed";
}) {
  return (
    <div className="flex h-6 min-w-0 items-center gap-1.5 text-xs">
      {author && (
        <span className="text-fg1 shrink-0 font-medium">{author}</span>
      )}
      <span
        className={cn(
          "min-w-0 truncate",
          tone === "merged"
            ? "text-violet-primary font-medium"
            : tone === "closed"
              ? "text-red-primary font-medium"
              : "text-fg2",
        )}
      >
        {verb}
      </span>
      <span className="text-muted-fg shrink-0">{relTime(at)}</span>
    </div>
  );
}

// ── review / comment cards ───────────────────────────────────

const VERDICT: Record<string, { label: string; cls: string }> = {
  APPROVED: { label: "Approved", cls: "bg-green-bg text-green-fg" },
  CHANGES_REQUESTED: {
    label: "Changes requested",
    cls: "bg-red-bg text-red-fg",
  },
  DISMISSED: { label: "Dismissed", cls: "bg-bg2-hover text-fg2" },
};

function TimelineCard({
  item,
  prNumber,
  optimistic,
  onAddToChat,
}: {
  item: ReviewTimelineEntry;
  prNumber: number;
  optimistic: boolean;
  onAddToChat: (text: string) => void;
}) {
  const verdict =
    item.kind === "review" ? VERDICT[item.state.toUpperCase()] : undefined;
  const html = useMemo(() => renderMarkdown(item.body), [item.body]);
  return (
    <div
      className={cn(
        "border-border2 bg-bg2 rounded-lg border transition-opacity duration-120 ease-out",
        optimistic && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 text-xs">
        <span className="text-fg1 min-w-0 truncate font-medium">
          @{item.author}
        </span>
        {verdict && (
          <span
            className={cn(
              "shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium",
              verdict.cls,
            )}
          >
            {verdict.label}
          </span>
        )}
        <span className="text-muted-fg shrink-0">
          {optimistic ? "Posting…" : relTime(item.createdAt)}
        </span>
        <div className="flex-1" />
        {item.body && !optimistic && (
          <Tooltip label="Quote this in the chat composer">
            <button
              type="button"
              onClick={() =>
                onAddToChat(
                  buildReviewCommentContext({
                    prNumber,
                    author: item.author,
                    state: item.kind === "review" ? item.state : "",
                    body: item.body,
                  }),
                )
              }
              className="text-2xxs text-fg2 hover:bg-bg2-hover hover:text-fg1 flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 transition-colors duration-120 ease-out"
            >
              <MessageSquarePlus className="size-3" /> Add to chat
            </button>
          </Tooltip>
        )}
      </div>
      {item.body ? (
        <div className="zeros-agent-md px-3 pt-1 pb-2.5 [&_.zeros-md-prose>:first-child]:mt-0 [&_.zeros-md-prose>:last-child]:mb-0">
          <div
            className="zeros-md-prose text-sm"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      ) : (
        <p className="text-muted-fg m-0 px-3 pt-1 pb-2.5 text-xs italic">
          {item.kind === "review"
            ? "Review submitted without a comment."
            : "(empty comment)"}
        </p>
      )}
    </div>
  );
}

// ── comment composer ─────────────────────────────────────────

function CommentComposer({
  onPost,
}: {
  onPost: (body: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = async () => {
    const body = value.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    // Optimistic: clear immediately (the card appears in the timeline); on
    // failure restore the draft so nothing is lost.
    setValue("");
    try {
      await onPost(body);
    } catch (e) {
      setValue(body);
      setError(humanGitError(e));
      textareaRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-border1 shrink-0 border-t p-3">
      {error && (
        <div className="mb-2">
          <ErrorCallout text={error} />
        </div>
      )}
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Leave a comment…"
        rows={2}
        className="bg-bg2 min-h-[56px] resize-none text-sm"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="text-2xxs text-muted-fg flex items-center gap-1">
          <Kbd>⌘↵</Kbd> to comment
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !value.trim()}
          onClick={() => void submit()}
          className="gap-1.5"
        >
          {busy && <ZerosSpinner size={16} />}
          Comment
        </Button>
      </div>
    </div>
  );
}
