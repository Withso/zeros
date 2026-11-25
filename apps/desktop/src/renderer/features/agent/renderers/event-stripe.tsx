// ──────────────────────────────────────────────────────────
// EventStripe — one working run (reasoning + tools)
// ──────────────────────────────────────────────────────────
//
// A run with two or more tool calls is a group: a collapsed header,
//
//   ▸ Worked for 48s  📄 >_ 🔍
//
// that counts its own time ("Working for" while it is the live tail) and
// carries the old "<N> tool calls, <M> messages" summary as its tooltip and
// accessible name. Opening it shows the rows. A smaller run renders its rows
// inline with no header. Sub-agent bodies always show their rows.
//
// Borderless. No card. No shadow. Just rows.
// ──────────────────────────────────────────────────────────

import { memo, useMemo } from "react";
import { ToolIdentityIcon } from "./tool-identity-icon";
import { nativeToolSurface, toolRecord } from "./native-tool-presentation";
import { safeToolImageSource } from "@zeros/protocol/tool-artwork";
import {
  ChevronDown,
  ChevronRight,
  CircleX,
  Globe2,
  SquareMousePointer,
} from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import { formatElapsed, WorkingDuration } from "@/renderer/shared/ui/loading";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import type { RendererContext } from "./types";
import { isInBetweenMessage } from "../turn-partition";
import { useTurnDisclosure } from "../turn-disclosures";
import { gatedEventIds, isWorkingGroup, workingFeedEvents, workingGroupSpan } from "../working-group";
import {
  countEventSummary,
  formatEventSummary,
  summaryIcons,
  iconForToolKind,
} from "./tool-summary";
import { MessageView } from "./message-view";
import { WORKING_FEED_GAP } from "./event-row";
import { groupShowsFailure } from "./tool-failure";
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
import { Inline } from "@/renderer/shared/ui/layout/inline";
import { ListRow } from "@/renderer/shared/ui/primitives/list-row";
import { Tooltip } from "@/renderer/shared/ui/primitives";

interface EventStripeProps {
  events: AgentMessage[];
  ctx: RendererContext;
  /** True while the turn is actively streaming. */
  live: boolean;
  /** Sub-agent bodies pass this: always render the (dimmed) children, never
   *  a group header — the SubagentCard row is the collapse boundary. */
  alwaysExpanded?: boolean;
  /** A final/result message rendered outside this feed is still a real
   * chronological boundary for its trailing Browser subgroup. */
  browserTailClosed?: boolean;
  /** Durable segment anchor that owns the group's open state. */
  groupKey?: string;
  /** The live turn's last run: its header counts up as "Working for". */
  tail?: boolean;
  /** A lone call shown on the loader line instead of as a row. */
  loaderEventId?: string;
}

// Brightness split inside the feed (styles/global/runtime-content.css,
// `.zeros-working-feed`): tool-row names and output markdown read at `fg1`;
// nested narration (TextMessage, carrying `[data-role]`) is muted to `fg3`.
// Top-level in-between messages folded into a group (`data-in-between`)
// keep `fg1`, the same as when they sit outside the group.

export const EventStripe = memo(function EventStripe({
  events: source,
  ctx,
  live,
  alwaysExpanded = false,
  browserTailClosed = false,
  groupKey,
  tail = false,
  loaderEventId,
}: EventStripeProps) {
  const allEvents = workingFeedEvents(source);
  const group = !alwaysExpanded && isWorkingGroup(allEvents);
  const [open, setOpen] = useTurnDisclosure<boolean>(groupKey ?? allEvents[0]?.id ?? "", "group", false);
  const events = group || !loaderEventId ? allEvents : allEvents.filter((event) => event.id !== loaderEventId);
  if (events.length === 0) return null;

  const gated = group && !open
    ? gatedEventIds(events, ctx.pendingPermission?.request.toolCall.toolCallId, ctx.pendingQuestionToolCallIds)
    : null;
  const feedEvents = gated ? events.filter((event) => gated.has(event.id)) : events;
  const displayEvents = groupBrowserToolActivity(feedEvents, {
    closeTail: browserActivityTailClosed(live, browserTailClosed),
  });

  return (
    <div className="flex flex-col">
      {group && (
        <GroupHeader
          events={events}
          ctx={ctx}
          tail={tail}
          browserClosed={browserActivityTailClosed(live, browserTailClosed)}
          open={open}
          onToggle={() => setOpen((value) => !value)}
        />
      )}
      {displayEvents.length > 0 && (
        // `zeros-working-feed` tags the group so runtime-content.css mutes
        // nested narration to fg3 and flattens narration padding. Each row
        // owns its OWN 4px top/bottom padding.
        //
        // Every feed — top-level AND nested agent / task bodies alike — puts
        // one uniform 8px gap (`gap-y-2`, see WORKING_FEED_GAP) between
        // entries. Entries are wrapped in a plain div so the gap lands between
        // entries and a row's inline permission cluster keeps hugging its
        // card. A renderer that emits several rows for ONE event (a command
        // reading many files) must repeat WORKING_FEED_GAP inside itself so
        // its rows keep the same rhythm.
        <div
          className={cn(
            "zeros-working-feed flex flex-col",
            WORKING_FEED_GAP,
            // The first entry sits one feed gap (8px) under the group header.
            group && "pt-2 pb-1",
          )}
        >
          {displayEvents.map((item) => {
            const content =
              item.kind === "browser-activity" ? (
                <BrowserActivityCard
                  surface={item.surface}
                  events={item.events}
                  actions={item.actions}
                  closed={item.closed}
                  ctx={ctx}
                />
              ) : (
                <MessageView message={item.event} ctx={ctx} />
              );
            return (
              <div
                key={item.id}
                data-in-between={
                  !alwaysExpanded && item.kind !== "browser-activity" && isInBetweenMessage(item.event)
                    ? true
                    : undefined
                }
                data-live-narration={
                  live &&
                  !browserTailClosed &&
                  item.kind !== "browser-activity" &&
                  item.event.kind === "text" &&
                  item.event.id === events.at(-1)?.id
                    ? true
                    : undefined
                }
                // A row that renders nothing yet (a thought whose description
                // has not settled) takes no gap in the feed.
                className="empty:hidden"
              >
                {content}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

function GroupHeader({ events, ctx, tail, browserClosed, open, onToggle }: {
  events: AgentMessage[];
  ctx: RendererContext;
  tail: boolean;
  browserClosed: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const Chev = open ? ChevronDown : ChevronRight;
  const summary = formatEventSummary(countEventSummary(events));
  const span = workingGroupSpan(events);
  const worked = formatElapsed(span?.durationMs ?? 0);
  const failed = useMemo(() => groupShowsFailure(events, browserClosed), [events, browserClosed]);
  return (
    <Tooltip label={summary}>
      <ListRow
        type="button"
        data-working-group={tail ? "live" : "closed"}
        // Content-width row (`w-fit`, lane-capped via `max-w-full`) so the
        // hover tint wraps the header, not the empty lane to the right.
        className="group/event-stripe min-w-0 transition-colors"
        onClick={onToggle}
        aria-expanded={open}
        // The ticking time stays out of the name; the summary joins it.
        aria-label={`${tail ? "Working" : `Worked for ${worked}`}, ${summary}${failed ? ", with a failed tool call" : ""}`}
      >
        <Chev className="text-fg2 size-3 shrink-0" />
        {/* "Working for 33.3s" becomes "Worked for 33s" in place, at once. */}
        <span className="text-fg2 shrink-0 text-reading leading-5 whitespace-nowrap">
          {tail ? "Working for " : "Worked for "}
          {tail && span ? (
            <WorkingDuration startedAt={span.startedAt} className="text-reading leading-5" />
          ) : (
            <span className="tabular-nums">{worked}</span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1 overflow-hidden">
          <StripeIcons
            events={events}
            chatId={ctx.chatId}
            active={ctx.attachmentImagesActive !== false}
          />
          {failed && <CircleX className="text-red-text size-3 shrink-0" aria-hidden="true" />}
        </span>
      </ListRow>
    </Tooltip>
  );
}

function StripeIcons({
  events,
  chatId,
  active,
}: {
  events: AgentMessage[];
  chatId: string | null;
  active: boolean;
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
  const latestBrowserUrl = [...browserActions]
    .reverse()
    .find((action) => action.url)?.url;
  const identityIcons = new Map<string, AgentToolMessage>();
  const genericEvents = (hasBrowser ? otherEvents : events).filter((event) => {
    if (event.kind !== "tool") return true;
    const surface = nativeToolSurface(event);
    const artwork = toolRecord(toolRecord(event.rawInput)._zerosToolArtwork);
    const identity = surface?.appId ?? safeToolImageSource(artwork.icon);
    if (!identity) return true;
    if (!identityIcons.has(identity)) identityIcons.set(identity, event);
    return false;
  });
  const nativeTools = [...identityIcons.values()].slice(0, hasBrowser ? 4 : 5);
  const icons = summaryIcons(genericEvents).slice(
    0,
    Math.max(0, (hasBrowser ? 4 : 5) - nativeTools.length),
  );
  if (!hasBrowser && icons.length === 0 && nativeTools.length === 0)
    return null;
  return (
    <Inline gap={1} align="center" className="shrink-0" aria-hidden="true">
      {hasBrowser ? (
        <span className="text-fg2 inline-flex size-3 items-center justify-center">
          <ToolIdentityIcon
            appId={browserActions.at(-1)?.appId}
            faviconUrl={
              browserFavicon ??
              browserActions.at(-1)?.faviconUrl ??
              (hasWebsiteActivity &&
              browserActions.at(-1)?.external &&
              latestBrowserUrl
                ? new URL("/favicon.ico", latestBrowserUrl).href
                : undefined)
            }
            fallback={hasWebsiteActivity ? Globe2 : SquareMousePointer}
            active={active}
            className="size-3"
          />
        </span>
      ) : null}
      {nativeTools.map((tool) => (
        <ToolIdentityIcon
          key={tool.id}
          artwork={toolRecord(tool.rawInput)._zerosToolArtwork}
          appId={nativeToolSurface(tool)?.appId}
          fallback={
            nativeToolSurface(tool)
              ? SquareMousePointer
              : iconForToolKind(tool.toolKind)
          }
          active={active}
          className="size-3"
        />
      ))}
      {icons.map((Icon, i) => (
        <span
          key={i}
          className="text-fg2 inline-flex size-3 items-center justify-center"
        >
          <Icon className="size-3" />
        </span>
      ))}
    </Inline>
  );
}
