// Overview · Comments — every comment on the pull request in one line each:
// conversation comments, review summaries, line comments from people and
// review apps, agents' workspace notes and code-scanning findings. A row
// opens its comment (at its line in Changes, or in a preview); hovering shows
// Hide and Add to chat, which stages the comment as a composer pill.

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, Circle, CircleCheck, ScanSearch } from "lucide-react";

import { Button, LIST_ROW_IN_GROUP, ListRow } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { AgentIcon } from "@/renderer/features/agent/agent-icon";
import {
  reviewCommentLocation,
  type ReviewCommentItem,
} from "@/renderer/features/code-review/review-comment-reference";
import {
  setReviewCommentHidden,
  useHiddenReviewComments,
} from "@/renderer/features/code-review/review-comment-hidden";
import { ReviewCommentPreviewDialog } from "@/renderer/features/code-review/review-comment-preview";
import { revealReviewComment } from "@/renderer/features/code-review/review-comment-open";
import { AuthorAvatar } from "./review-shared-components";
import { REVIEW_CARD, ReviewSection } from "./review-overview";

const ROW_LIMIT = 50;
const INCOMPLETE = "Some comments couldn't be loaded, so this list may be incomplete.";
const ROW =
  "group border-border1 relative flex min-h-10 min-w-0 items-center gap-2.5 py-1 pr-2 pl-3.5 hover:bg-bg1-raised-hover has-[[data-list-row-disclosure]:focus-visible]:inset-ring has-[[data-list-row-disclosure]:focus-visible]:inset-ring-accent [&+&]:border-t";

/** A title's `code` spans set as code. */
function CommentTitle({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 && index < parts.length - 1 ? (
          <code key={index} className="bg-bg2 text-fg1 text-3xxs rounded-sm px-1 py-px font-mono leading-4">
            {part}
          </code>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function CommentMark({ item }: { item: ReviewCommentItem }) {
  if (item.source === "check")
    return (
      <span aria-hidden className="bg-bg2 text-fg2 inline-flex size-5 shrink-0 items-center justify-center rounded-sm [&_svg]:size-3">
        <ScanSearch />
      </span>
    );
  if (item.provider)
    return (
      <span aria-hidden className="bg-bg2 inline-flex size-5 shrink-0 items-center justify-center rounded-sm">
        <AgentIcon agentId={item.provider} iconUrl={null} size={12} />
      </span>
    );
  return (
    <AuthorAvatar
      login={item.reference.author.name}
      avatarUrl={item.reference.author.avatarUrl}
      className="shrink-0"
    />
  );
}

function CommentRow({
  item,
  cwd,
  hidden,
  onHide,
  onAddToChat,
  onPreview,
}: {
  item: ReviewCommentItem;
  cwd: string;
  hidden: boolean;
  onHide: (hidden: boolean) => void;
  onAddToChat: () => void;
  onPreview: () => void;
}) {
  const ref = item.reference;
  const location = reviewCommentLocation(ref);
  const Status = ref.resolved ? CircleCheck : Circle;
  return (
    <div
      role="listitem"
      data-review-comment={item.source}
      data-resolved={ref.resolved ? "" : undefined}
      className={ROW}
    >
      <Status
        aria-label={ref.resolved ? "Resolved" : ref.resolved === false ? "Unresolved" : undefined}
        aria-hidden={ref.resolved === undefined || undefined}
        className={cn("size-3.5 shrink-0", ref.resolved ? "text-green-text" : "text-fg3")}
      />
      <CommentMark item={item} />
      <ListRow
        data-list-row-disclosure=""
        className={cn(LIST_ROW_IN_GROUP, "flex-1 gap-2")}
        title={location ? reviewCommentLocation(ref, true) ?? undefined : undefined}
        onClick={() => {
          if (!revealReviewComment(cwd, ref)) onPreview();
        }}
      >
        <span className="text-fg1 max-w-[40%] shrink-0 truncate text-xs font-medium">
          {ref.author.name}
        </span>
        <span className={cn("min-w-0 truncate text-xs", hidden || ref.resolved ? "text-fg3" : "text-fg2")}>
          <CommentTitle text={ref.title} />
        </span>
      </ListRow>
      {location ? (
        <span className="text-fg3 text-3xxs max-w-[30%] shrink-0 truncate font-mono">
          {location}
        </span>
      ) : null}
      {/* Over the row's end, so showing them moves nothing under the pointer.
          Transparent rather than hidden: they stay in the tab order, and
          keyboard focus reveals them. */}
      <div className="bg-bg1-raised-hover absolute inset-y-0 right-0 flex items-center gap-1 pr-2 pl-3 opacity-0 transition-opacity duration-fast ease-out group-focus-within:opacity-100 group-hover:opacity-100">
        <Button variant="ghost" size="compact" className="text-fg2" onClick={() => onHide(!hidden)}>
          {hidden ? "Unhide" : "Hide"}
        </Button>
        <Button variant="secondary" size="compact" onClick={onAddToChat}>
          Add to chat
        </Button>
      </div>
    </div>
  );
}

/** One line per comment, unresolved first. Hidden and resolved comments fold
 *  under their own toggles; Add all to chat takes the open, shown ones. */
export function CommentsSection({
  items,
  loading = false,
  incomplete = false,
  owner,
  prNumber,
  cwd,
  onAddToChat,
}: {
  items: readonly ReviewCommentItem[];
  /** A read the list depends on has not answered yet. */
  loading?: boolean;
  /** A source couldn't be fully read; the workbench banner names why. */
  incomplete?: boolean;
  /** Workspace identity; hidden comments are remembered per owner and PR. */
  owner: string;
  prNumber: number;
  cwd: string;
  onAddToChat: (items: readonly ReviewCommentItem[]) => void;
}) {
  const hiddenKeys = useHiddenReviewComments(owner, prNumber);
  const [showResolved, setShowResolved] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [preview, setPreview] = useState<ReviewCommentItem | null>(null);
  const [showAll, setShowAll] = useState(false);
  const { open, resolved, hidden } = useMemo(() => {
    const groups = {
      open: [] as ReviewCommentItem[],
      resolved: [] as ReviewCommentItem[],
      hidden: [] as ReviewCommentItem[],
    };
    for (const item of items) {
      if (hiddenKeys.has(item.reference.key)) groups.hidden.push(item);
      else if (item.reference.resolved) groups.resolved.push(item);
      else groups.open.push(item);
    }
    return groups;
  }, [items, hiddenKeys]);
  if (items.length === 0)
    return (
      <ReviewSection title="Comments">
        {loading ? (
          <div data-review-comments="" aria-busy="true" className={cn(REVIEW_CARD, "min-h-10")} />
        ) : (
          <p className="text-fg3 m-0 text-xs">
            {incomplete ? INCOMPLETE : "No comments yet."}
          </p>
        )}
      </ReviewSection>
    );
  const all = [
    ...open,
    ...(showResolved ? resolved : []),
    ...(showHidden ? hidden : []),
  ];
  // Code scanning can report hundreds of findings; draw a page until asked.
  const rows = showAll ? all : all.slice(0, ROW_LIMIT);
  const toggle = (
    label: string,
    expanded: boolean,
    onClick: () => void,
  ) => (
    <div className="border-border1 flex min-h-9 items-center py-1 pl-2 [&:not(:first-child)]:border-t">
      <Button variant="ghost" size="compact" className="text-fg3" aria-expanded={expanded} onClick={onClick}>
        <ChevronDown aria-hidden className={cn("transition-transform", expanded && "rotate-180")} />
        {label}
      </Button>
    </div>
  );
  return (
    <ReviewSection
      title="Comments"
      count={open.length}
      action={
        open.length > 1 ? (
          <Button variant="ghost" size="compact" className="text-fg2" onClick={() => onAddToChat(open)}>
            Add all to chat
          </Button>
        ) : null
      }
    >
      {incomplete ? <p className="text-fg3 m-0 mb-2 text-xs">{INCOMPLETE}</p> : null}
      <div data-review-comments="" className={REVIEW_CARD}>
        {rows.length ? (
          <div role="list" aria-label="Comments">
            {rows.map((item) => (
              <CommentRow
                key={item.reference.key}
                item={item}
                cwd={cwd}
                hidden={hiddenKeys.has(item.reference.key)}
                onHide={(value) => setReviewCommentHidden(owner, prNumber, item.reference.key, value)}
                onAddToChat={() => onAddToChat([item])}
                onPreview={() => setPreview(item)}
              />
            ))}
          </div>
        ) : null}
        {all.length > rows.length
          ? toggle(`Show ${all.length - rows.length} more`, false, () => setShowAll(true))
          : null}
        {resolved.length > 0
          ? toggle(
              showResolved ? "Hide resolved" : `Show ${resolved.length} resolved`,
              showResolved,
              () => setShowResolved((value) => !value),
            )
          : null}
        {hidden.length > 0
          ? toggle(
              showHidden ? "Fold hidden" : `Show ${hidden.length} hidden`,
              showHidden,
              () => setShowHidden((value) => !value),
            )
          : null}
      </div>
      {preview ? (
        <ReviewCommentPreviewDialog
          // The list keeps a bounded copy; the preview reads the whole comment.
          reference={{ ...preview.reference, body: preview.fullBody }}
          open
          onOpenChange={(value) => {
            if (!value) setPreview(null);
          }}
        />
      ) : null}
    </ReviewSection>
  );
}
