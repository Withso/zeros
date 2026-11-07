// ──────────────────────────────────────────────────────────
// ReviewTimelineSection — the Review tab's Reviews sub-tab
// ──────────────────────────────────────────────────────────
//
// One chronological activity stream (composeTimeline): opened → commits →
// reviews/comments → merged/closed, drawn on a connector rail with avatars.
// All, People and Bots filter it once an App has taken part; an App's review
// or comment folds to one line until Show. Review + comment bodies render as
// sanitised markdown cards with "Add to chat" (quoted context lands in the
// active composer — the user adds instructions and sends). The composer at
// the bottom posts optimistically: the comment appears instantly, reconciles
// against GitHub in the background, and rolls back (keeping the draft) if the
// post fails.

import React, { useMemo, useRef, useState } from "react";
import {
  GitCommit,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  Globe,
} from "lucide-react";

import type { PR, PrChecksResult, PrCommitSummary } from "../../../platform/git";
import { AgentIcon } from "@/renderer/features/agent/agent-icon";
import type { ReviewCommitChat } from "./review-commit-chats";
import {
  Badge,
  Button,
  ButtonShortcut,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { renderMarkdown } from "@/renderer/features/agent/markdown";
import { buildReviewCommentContext } from "../../pr/pr-action-prompts";
import { humanGitError, type ReviewTimelineEntry } from "./review-data";
import {
  appDisplayName,
  composeTimeline,
  filterTimelineEvents,
  isBotLogin,
  relTime,
  type ReviewTimelineEvent,
  type TimelineFilter,
} from "./review-model";
import {
  AuthorAvatar,
  ErrorCallout,
  OutcomeGlyph,
  ReviewTextLink,
} from "./review-shared-components";
import { REVIEW_CARD, ReviewSection, SUBTAB_FRAME } from "./review-overview";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { useScrollMemoryRef } from "../../scroll-memory";
import { captureDeferredFocus } from "@/renderer/shared/ui/deferred-focus";

export function ReviewTimelineSection({
  pr,
  prNumber,
  commits,
  timeline,
  loading,
  error,
  scrollKey,
  hostLabel,
  viewer = null,
  onAddToChat,
  onPostComment,
  onRetry,
  checks = null,
  chats,
  onOpenChat,
  onViewChecks,
}: {
  pr: PR | null;
  prNumber: number;
  commits: PrCommitSummary[] | null;
  timeline: ReviewTimelineEntry[] | null;
  loading: boolean;
  error: string | null;
  /** Exact workspace+PR owner for the nested timeline scroller. */
  scrollKey: string;
  /** Where a comment posts ("GitHub"). */
  hostLabel: string;
  /** The account a comment posts as, beside the comment box. */
  viewer?: { login: string; avatarUrl: string | null } | null;
  onAddToChat: (text: string) => void;
  onPostComment: (body: string) => Promise<void>;
  onRetry: () => void;
  /** The head commit's checks; its failures join the stream. */
  checks?: PrChecksResult | null;
  /** sha → the chat whose turn made the commit. */
  chats?: ReadonlyMap<string, ReviewCommitChat>;
  onOpenChat?: (chatId: string) => void;
  /** Show the Checks sub-tab (a failure's View checks). */
  onViewChecks?: () => void;
}) {
  const timelineScrollRef = useScrollMemoryRef(scrollKey);
  const events = useMemo(
    () =>
      composeTimeline({
        pr,
        commits: commits ?? [],
        items: timeline ?? [],
        checks,
      }),
    [pr, commits, timeline, checks],
  );
  const optimisticIds = useMemo(
    () =>
      new Set((timeline ?? []).filter((t) => t.optimistic).map((t) => t.id)),
    [timeline],
  );
  // The switch appears once an App has taken part; until then People is All.
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const botCount = useMemo(
    () => filterTimelineEvents(events, "bots").length,
    [events],
  );
  const shown = useMemo(
    () => filterTimelineEvents(events, botCount > 0 ? filter : "all"),
    [events, filter, botCount],
  );

  const body =
    shown.length === 0 ? (
      loading && !timeline ? (
        <div className="min-h-24" aria-busy="true" />
      ) : (
        <p className="text-fg3 m-0 text-xs">
          {events.length === 0
            ? "No activity yet. Reviews and comments land here live."
            : "Nothing here for this filter."}
        </p>
      )
    ) : (
      <ol className="m-0 flex list-none flex-col">
        {shown.map((e, i) => (
          <TimelineRow
            key={eventKey(e, i)}
            event={e}
            last={i === shown.length - 1}
            prNumber={prNumber}
            optimistic={
              (e.kind === "comment" || e.kind === "review") &&
              optimisticIds.has(e.item.id)
            }
            onAddToChat={onAddToChat}
            chat={e.kind === "commit" ? chats?.get(e.commit.sha) : undefined}
            onOpenChat={onOpenChat}
            onViewChecks={onViewChecks}
          />
        ))}
      </ol>
    );

  const filterSwitch =
    botCount > 0 ? (
      <Tabs
        value={filter}
        onValueChange={(next) => setFilter(next as TimelineFilter)}
      >
        <TabsList aria-label="Show activity from">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
          <TabsTrigger value="bots">
            Bots
            <span className="text-fg3 font-normal tabular-nums">{botCount}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={timelineScrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className={SUBTAB_FRAME}>
          {error && <ErrorCallout text={error} onRetry={onRetry} />}
          <ReviewSection
            title="Activity"
            count={timeline?.length}
            action={filterSwitch}
          >
            {body}
          </ReviewSection>
        </div>
      </div>
      <CommentComposer onPost={onPostComment} hostLabel={hostLabel} viewer={viewer} />
    </div>
  );
}

function eventKey(e: ReviewTimelineEvent, i: number): string {
  switch (e.kind) {
    case "commit":
      return `commit-${e.commit.sha}`;
    case "check":
      return `check-${e.sha}-${e.check.name}-${e.at}`;
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
  chat,
  onOpenChat,
  onViewChecks,
}: {
  event: ReviewTimelineEvent;
  last: boolean;
  prNumber: number;
  optimistic: boolean;
  onAddToChat: (text: string) => void;
  /** The chat whose turn made this commit. */
  chat?: ReviewCommitChat;
  onOpenChat?: (chatId: string) => void;
  onViewChecks?: () => void;
}) {
  const isCard = event.kind === "review" || event.kind === "comment";
  return (
    <li className="relative flex gap-2.5 pb-1">
      {/* rail */}
      <div className="flex w-6 shrink-0 flex-col items-center">
        <div className="flex h-6 shrink-0 items-center justify-center">
          <EventGlyph event={event} chat={chat} />
        </div>
        {!last && <div className="bg-border2 w-px flex-1" />}
      </div>
      <div className={cn("min-w-0 flex-1 pb-2", isCard && "pb-3")}>
        <EventBody
          event={event}
          prNumber={prNumber}
          optimistic={optimistic}
          onAddToChat={onAddToChat}
          chat={chat}
          onOpenChat={onOpenChat}
          onViewChecks={onViewChecks}
        />
      </div>
    </li>
  );
}

function EventGlyph({
  event,
  chat,
}: {
  event: ReviewTimelineEvent;
  chat?: ReviewCommitChat;
}) {
  switch (event.kind) {
    case "opened":
      return <GitPullRequestArrow className="text-green-primary size-3.5" />;
    case "commit":
      // A chat's commit wears its agent's mark, as the chat's own rows do.
      return chat?.agentId ? (
        <AgentIcon agentId={chat.agentId} iconUrl={null} size={14} />
      ) : (
        <GitCommit className="text-fg2 size-3.5" />
      );
    case "check":
      return <OutcomeGlyph outcome="failed" />;
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
  chat,
  onOpenChat,
  onViewChecks,
}: {
  event: ReviewTimelineEvent;
  prNumber: number;
  optimistic: boolean;
  onAddToChat: (text: string) => void;
  chat?: ReviewCommitChat;
  onOpenChat?: (chatId: string) => void;
  onViewChecks?: () => void;
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
    case "commit": {
      const coAuthor = event.commit.coAuthors[0]?.name;
      return (
        <div className="flex h-6 min-w-0 items-center gap-1.5 text-xs" data-review-event-commit={event.commit.abbreviatedSha}>
          <span className="text-fg1 shrink-0 font-medium">
            {event.commit.authorLogin ?? event.commit.authorName}
          </span>
          {coAuthor && (
            <>
              <span className="text-fg2 shrink-0">and</span>
              <span className="text-fg1 shrink-0 font-medium">{coAuthor}</span>
            </>
          )}
          <span className="text-fg2 shrink-0">committed</span>
          <span className="bg-bg2 text-fg2 text-3xxs shrink-0 rounded-sm px-1.5 font-mono leading-5">
            {event.commit.abbreviatedSha}
          </span>
          {chat && onOpenChat ? (
            <>
              <span className="text-fg2 shrink-0">from the chat</span>
              <ReviewTextLink onClick={() => onOpenChat(chat.chatId)} label={`Open the chat ${chat.title}`}>
                {chat.title}
              </ReviewTextLink>
            </>
          ) : (
            <span className="text-fg1 min-w-0 truncate">
              {event.commit.message.split("\n")[0]}
            </span>
          )}
          <span className="text-muted-fg shrink-0">{relTime(event.at)}</span>
        </div>
      );
    }
    case "check":
      return (
        <div className="flex h-6 min-w-0 items-center gap-1.5 text-xs" data-review-event-check={event.check.name}>
          <span className="text-fg1 min-w-0 truncate font-medium">{event.check.name}</span>
          <span className="text-fg2 shrink-0">failed on</span>
          <span className="bg-bg2 text-fg2 text-3xxs shrink-0 rounded-sm px-1.5 font-mono leading-5">
            {event.sha.slice(0, 7)}
          </span>
          <span className="text-muted-fg shrink-0">{relTime(event.at)}</span>
          {onViewChecks && (
            <>
              <span className="text-muted-fg shrink-0">·</span>
              <ReviewTextLink onClick={onViewChecks} arrow={false}>
                View checks
              </ReviewTextLink>
            </>
          )}
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
      return isBotLogin(event.item.author) ? (
        <BotTimelineCard
          item={event.item}
          prNumber={prNumber}
          onAddToChat={onAddToChat}
        />
      ) : (
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

/** An App's review or comment as one line until Show. */
function BotTimelineCard({
  item,
  prNumber,
  onAddToChat,
}: {
  item: ReviewTimelineEntry;
  prNumber: number;
  onAddToChat: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <TimelineCard
        item={item}
        prNumber={prNumber}
        optimistic={false}
        onAddToChat={onAddToChat}
        onHide={() => setOpen(false)}
      />
    );
  return (
    <div
      data-review-bot-event=""
      className={cn(REVIEW_CARD, "flex min-h-10 items-center gap-2 py-1.5 pr-1.5 pl-3 text-xs")}
    >
      <span className="text-fg1 min-w-0 truncate font-medium">
        {appDisplayName(item.author)}
      </span>
      <Badge variant="neutral">Bot</Badge>
      <span className="text-fg2 min-w-0 flex-1 truncate">
        {item.kind === "review" ? "left a review" : "commented"}
      </span>
      <span className="text-fg3 shrink-0">{relTime(item.createdAt)}</span>
      <Button
        variant="ghost"
        size="compact"
        className="text-fg2"
        aria-expanded={false}
        onClick={() => setOpen(true)}
      >
        Show
      </Button>
    </div>
  );
}

function TimelineCard({
  item,
  prNumber,
  optimistic,
  onAddToChat,
  onHide,
}: {
  item: ReviewTimelineEntry;
  prNumber: number;
  optimistic: boolean;
  onAddToChat: (text: string) => void;
  /** Folds an App's card back to its one line. */
  onHide?: () => void;
}) {
  const verdict =
    item.kind === "review" ? VERDICT[item.state.toUpperCase()] : undefined;
  const html = useMemo(() => renderMarkdown(item.body), [item.body]);
  return (
    <div
      className={cn(
        REVIEW_CARD,
        "transition-opacity duration-120 ease-out",
        optimistic && "opacity-70",
      )}
    >
      <div className="flex min-h-9 items-center gap-2 pt-1.5 pr-1.5 pl-3 text-xs">
        <span className="text-fg1 min-w-0 truncate font-medium">
          {appDisplayName(item.author)}
        </span>
        {isBotLogin(item.author) && <Badge variant="neutral">Bot</Badge>}
        {verdict && (
          <span
            className={cn(
              "text-xxs shrink-0 rounded-sm px-1.5 py-0.5 font-medium",
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
          <Button
            variant="ghost"
            size="compact"
            className="text-fg2"
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
          >
            Add to chat
          </Button>
        )}
        {onHide && (
          <Button
            variant="ghost"
            size="compact"
            className="text-fg2"
            aria-expanded
            onClick={onHide}
          >
            Hide
          </Button>
        )}
      </div>
      {item.body ? (
        <div className="zeros-agent-md zeros-agent-md--panel px-3 pt-1 pb-2.5 [&_.zeros-md-prose>:first-child]:mt-0 [&_.zeros-md-prose>:last-child]:mb-0">
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
  hostLabel,
  viewer,
}: {
  onPost: (body: string) => Promise<void>;
  hostLabel: string;
  viewer: { login: string; avatarUrl: string | null } | null;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = async () => {
    const body = value.trim();
    if (!body || busy) return;
    const mayRestoreFocus = captureDeferredFocus(textareaRef.current?.parentElement ?? null);
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
      if (mayRestoreFocus()) textareaRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-review-comment-composer=""
      className="border-border1 grid shrink-0 grid-cols-[20px_minmax(0,1fr)] items-start gap-x-2.5 border-t px-5 pt-3 pb-4"
    >
      {/* Whoever the comment posts as; the column stays when that's unknown. */}
      <span className="mt-1.5">
        {viewer ? <AuthorAvatar login={viewer.login} avatarUrl={viewer.avatarUrl} /> : null}
      </span>
      <div className="min-w-0">
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
        <span className="text-fg3 text-3xxs flex items-center gap-1 leading-4">
          <Globe aria-hidden className="size-3" /> Posts to {hostLabel}
        </span>
        <div className="flex-1" />
        <Button
          size="compact"
          variant="secondary"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          disabled={busy || !value.trim()}
          onClick={() => void submit()}
        >
          {busy && <ZerosSpinner size={16} />}
          Comment
          <ButtonShortcut keys="⌘↵" />
        </Button>
      </div>
      </div>
    </div>
  );
}
