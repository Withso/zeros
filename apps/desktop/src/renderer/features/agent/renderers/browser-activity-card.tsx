import { memo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Globe2,
  SquareMousePointer,
} from "lucide-react";

import {
  cachedBrowserFavicon,
  useConversationBrowserActivity,
} from "../../browser/browser-session-activity-store";
import {
  browserActivityGroupStatus,
  resolveBrowserActivityPresentation,
  resolveBrowserActionUrls,
  browserActivityUsesWebsiteIcon,
  type BrowserToolActivity,
} from "../../browser/browser-tool-activity";
import type { AgentToolMessage } from "../use-agent-session";
import type { RendererContext } from "./types";
import { NativeBrowserToolRow } from "./event-row-renderer";

const MAX_VISIBLE_ACTIONS = 24;

export const BrowserActivityCard = memo(function BrowserActivityCard({
  events,
  actions,
  closed,
  ctx,
}: {
  events: AgentToolMessage[];
  actions: BrowserToolActivity[];
  closed: boolean;
  ctx: RendererContext;
}) {
  const [open, setOpen] = useState(false);
  const session = useConversationBrowserActivity(ctx.chatId ?? undefined);
  const latest = actions.at(-1);
  const groupStatus = browserActivityGroupStatus(events, closed);
  const running = groupStatus === "browsing";
  const { faviconDataUrl: liveFaviconDataUrl } =
    resolveBrowserActivityPresentation(actions, running, session);
  const faviconDataUrl =
    liveFaviconDataUrl ??
    cachedBrowserFavicon(
      [...actions].reverse().find((action) => action.url)?.url,
    );
  const failed = groupStatus === "failed";
  const hasWebsiteActivity = actions.some(browserActivityUsesWebsiteIcon);
  const visible = actions.slice(-MAX_VISIBLE_ACTIONS);
  const visibleEvents = events.slice(-MAX_VISIBLE_ACTIONS);
  const visibleUrls =
    resolveBrowserActionUrls(actions).slice(-MAX_VISIBLE_ACTIONS);
  const omitted = Math.max(0, actions.length - visible.length);
  const Chevron = open ? ChevronDown : ChevronRight;
  const statusLabel = running
    ? "Browsing"
    : failed
      ? "Browser use failed"
      : "Used the browser";
  const liveTitles = running
    ? actions
        .filter(
          (action) =>
            action.status === "pending" || action.status === "in_progress",
        )
        .map((action) => action.label)
        .slice(-2)
        .join(" · ") || latest?.label
    : undefined;

  return (
    <div className="max-w-full" data-browser-activity-count={actions.length}>
      <button
        type="button"
        className="hover:bg-bg2-hover/40 -ml-2 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={statusLabel}
      >
        <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
          {faviconDataUrl ? (
            <img src={faviconDataUrl} alt="" className="size-4 rounded-[3px]" />
          ) : hasWebsiteActivity ? (
            <Globe2
              className={
                failed ? "text-red-primary size-3.5" : "text-fg2 size-3.5"
              }
              aria-hidden="true"
            />
          ) : (
            <SquareMousePointer
              className={
                failed ? "text-red-primary size-3.5" : "text-fg2 size-3.5"
              }
              aria-hidden="true"
            />
          )}
        </span>
        <span className="text-fg1 min-w-0 truncate text-sm">{statusLabel}</span>
        {liveTitles ? (
          <span className="text-fg2 min-w-0 truncate text-xs">
            {liveTitles}
          </span>
        ) : null}
        <Chevron className="text-fg3 size-3 shrink-0" aria-hidden="true" />
      </button>
      {open ? (
        <div className="border-border1 mt-1 ml-2 flex max-w-[680px] flex-col border-l pl-3">
          {omitted > 0 ? (
            <div className="text-fg3 py-1 text-xs">
              {omitted} earlier browser actions condensed
            </div>
          ) : null}
          {visible.map((_action, index) => {
            const event = visibleEvents[index]!;
            // This card only receives calls admitted by the chronological
            // Browser-group classifier. Rendering every provider through the
            // same semantic row keeps Claude-in-Chrome MCP names and Codex's
            // node_repl implementation details out of the visible transcript.
            return (
              <NativeBrowserToolRow
                key={event.id}
                tool={event}
                ctx={ctx}
                inheritedUrl={visibleUrls[index]}
                browserActivity={visible[index]}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
});
