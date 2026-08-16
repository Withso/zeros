// ──────────────────────────────────────────────────────────
// EventStripe — the "working" group (reasoning + tools)
// ──────────────────────────────────────────────────────────
//
// A turn's working content — tool calls, thinking, in-between
// narration, sub-agents — renders as ONE group:
//
//   • While the turn is LIVE (the agent is working): fully
//     EXPANDED with NO header chip, every row dimmed, each
//     individual item collapsed to one line. The user watches
//     the agent reason + act in real time.
//
//   • Once the turn settles (live=false): ordinary work
//     COLLAPSES into one chip —
//
//       ▸ 📄 >_ 🔍 🤖  6 tool calls, 2 messages, 3 agents
//
//     — and the agent's final answer (rendered by the parent,
//     bright) sits below it. Click the chip to re-expand the
//     dimmed history, including its nested Browser activity group.
//
// Borderless. No card. No shadow. Just rows.
// ──────────────────────────────────────────────────────────

import { Fragment, memo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Globe2,
  SquareMousePointer,
} from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import type { RendererContext } from "./types";
import {
  countEventSummary,
  formatEventSummary,
  summaryIcons,
} from "./tool-summary";
import { MessageView } from "./message-view";
import {
  browserActivityTailClosed,
  browserActivityUsesWebsiteIcon,
  groupBrowserToolActivity,
  partitionBrowserActivityForSummary,
  resolveBrowserActivityPresentation,
} from "../../browser/browser-tool-activity";
import { BrowserActivityCard } from "./browser-activity-card";
import {
  cachedBrowserFavicon,
  useConversationBrowserActivity,
} from "../../browser/browser-session-activity-store";

interface EventStripeProps {
  events: AgentMessage[];
  ctx: RendererContext;
  /** True while the turn is actively streaming — the agent is "working."
   *  A live group renders fully expanded, no header chip, rows dimmed. Once
   *  the turn finishes (live=false) it collapses into one summary chip. */
  live: boolean;
  /** Sub-agent bodies pass this: always render the (dimmed) children, never
   *  the collapse chip — the SubagentCard row is the collapse boundary. */
  alwaysExpanded?: boolean;
  /** A final/result message rendered outside this feed is still a real
   * chronological boundary for its trailing Browser subgroup. */
  browserTailClosed?: boolean;
}

// Brightness split inside the feed (styles/global/runtime-content.css,
// `.zeros-working-feed`):
// tool-row NAMES and OUTPUT markdown (the top-level answer, and a sub-agent's
// result/"Output" — a bare `.zeros-agent-md`) read at full `fg1`; only the
// in-between NARRATION (TextMessage, carrying `[data-role]`) is muted to `fg2`,
// uniformly down to bold/headings/links. So output reads like our own output
// markdown at every depth. The working-vs-answer
// split is also structural: the feed collapses to one summary chip on settle.

export const EventStripe = memo(function EventStripe({
  events,
  ctx,
  live,
  alwaysExpanded = false,
  browserTailClosed = false,
}: EventStripeProps) {
  const [userExpanded, setUserExpanded] = useState(false);

  // Force the group open while it holds a pending permission, so the gated
  // row (e.g. Claude's "Plan ready for review") is never hidden inside a
  // collapsed summary chip while the user's decision pends: the plan must stay
  // visible until approved or rejected.
  // ⚠️ The permission request references the VENDOR's tool-use id, which is
  // the transcript row's nativeToolCallId (the Claude translator mints its
  // own uuid for toolCallId) — match BOTH, same as the question record.
  const pendingPermId = ctx.pendingPermission?.request.toolCall.toolCallId;
  const hasPendingPermission =
    !!pendingPermId &&
    events.some((e) => {
      if (e.kind !== "tool") return false;
      const t = e as AgentToolMessage;
      return (
        t.toolCallId === pendingPermId || t.nativeToolCallId === pendingPermId
      );
    });

  // Same guard for a pending blocking QUESTION: its "Awaiting response"
  // record row must stay visible while the user's answer pends, not fold
  // into a collapsed chip (the interactive card lives in the composer slot,
  // but the transcript record is the only in-feed cue it's waiting).
  const hasPendingQuestion =
    ctx.pendingQuestionToolCallIds.size > 0 &&
    events.some((e) => {
      if (e.kind !== "tool") return false;
      const t = e as AgentToolMessage;
      return (
        ctx.pendingQuestionToolCallIds.has(t.toolCallId) ||
        (!!t.nativeToolCallId &&
          ctx.pendingQuestionToolCallIds.has(t.nativeToolCallId))
      );
    });

  if (events.length === 0) return null;

  const canCollapse =
    !live && !alwaysExpanded && !hasPendingPermission && !hasPendingQuestion;
  const showHeader = canCollapse && events.length > 0;
  const expanded = !showHeader || userExpanded;
  const Chev = expanded ? ChevronDown : ChevronRight;
  const displayEvents = groupBrowserToolActivity(events, {
    closeTail: browserActivityTailClosed(live, browserTailClosed),
  });

  return (
    <div className="flex flex-col">
      {showHeader && (
        <button
          type="button"
          // Content-width chip (`w-fit`, lane-capped via `max-w-full`) so the
          // hover tint wraps the summary + icons, not the empty lane to the
          // right; hover should fit the content.
          className="group/event-stripe hover:bg-bg2-hover/40 -ml-1 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors"
          onClick={() => setUserExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <Chev className="text-fg2 size-3 shrink-0" />
          {/* The roll-up FIRST: "<N> tool calls, <M> messages, <K> agents".
              Natural width (truncates if the row is narrow) so the icons sit
              directly after it rather than at the far right edge. */}
          <span className="text-fg2 min-w-0 truncate text-sm">
            {formatEventSummary(countEventSummary(events))}
          </span>
          {/* Activity icons at the END, after the text: deduped tool kinds +
              Bot (any sub-agent) + Brain (any
              reasoning), capped at 5, visible. */}
          <StripeIcons events={events} chatId={ctx.chatId} />
        </button>
      )}
      {expanded && (
        // `zeros-working-feed` tags the group so runtime-content.css mutes it to fg2 and
        // flattens narration padding. Each row owns its OWN 4px top/bottom
        // padding (`py-1` on the hover target itself, not an outer wrapper).
        //
        // A TOP-LEVEL feed adds a 4px gap BETWEEN entries (`gap-y-1`) for
        // breathing room; a NESTED agent / task body (`alwaysExpanded`) keeps
        // its many tool calls tight, with no gap. Top-level entries are wrapped
        // in a plain div so the gap
        // lands between entries and a row's inline permission cluster keeps
        // hugging its card; nested rows render directly, unchanged.
        <div
          className={cn(
            "zeros-working-feed flex flex-col",
            !alwaysExpanded && "gap-y-1",
            showHeader && "py-1",
          )}
        >
          {displayEvents.map((item) => {
            const content =
              item.kind === "browser-activity" ? (
                <BrowserActivityCard
                  events={item.events}
                  actions={item.actions}
                  closed={item.closed}
                  ctx={ctx}
                />
              ) : (
                <MessageView message={item.event} ctx={ctx} />
              );
            return alwaysExpanded ? (
              <Fragment key={item.id}>{content}</Fragment>
            ) : (
              <div key={item.id}>{content}</div>
            );
          })}
        </div>
      )}
    </div>
  );
});

function StripeIcons({
  events,
  chatId,
}: {
  events: AgentMessage[];
  chatId: string | null;
}) {
  const session = useConversationBrowserActivity(chatId ?? undefined);
  const {
    browserEvents,
    actions: browserActions,
    otherEvents,
  } = partitionBrowserActivityForSummary(events);
  const hasBrowser = browserEvents.length > 0;
  const browserRunning = browserEvents.some(
    (event) =>
      event.kind === "tool" &&
      (event.status === "pending" || event.status === "in_progress"),
  );
  const presentation = resolveBrowserActivityPresentation(
    browserActions,
    browserRunning,
    session,
  );
  const browserFavicon =
    presentation.faviconDataUrl ??
    cachedBrowserFavicon(
      [...browserActions].reverse().find((activity) => activity.url)?.url,
    );
  const hasWebsiteActivity = browserActions.some(
    browserActivityUsesWebsiteIcon,
  );
  const icons = summaryIcons(hasBrowser ? otherEvents : events).slice(
    0,
    hasBrowser ? 4 : 5,
  );
  if (!hasBrowser && icons.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-1" aria-hidden="true">
      {hasBrowser ? (
        <span className="text-fg2 inline-flex size-3 items-center justify-center">
          {browserFavicon ? (
            <img src={browserFavicon} alt="" className="size-3 rounded-[2px]" />
          ) : hasWebsiteActivity ? (
            <Globe2 className="size-3" />
          ) : (
            <SquareMousePointer className="size-3" />
          )}
        </span>
      ) : null}
      {icons.map((Icon, i) => (
        <span
          key={i}
          className="text-fg2 inline-flex size-3 items-center justify-center"
        >
          <Icon className="size-3" />
        </span>
      ))}
    </div>
  );
}
