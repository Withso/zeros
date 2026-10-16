import { memo } from "react";
import { useTurnDisclosure } from "../turn-disclosures";
import {
  ChevronDown,
  ChevronRight,
  Globe2,
  Smartphone,
  SquareMousePointer,
} from "lucide-react";

import {
  cachedBrowserFavicon,
  useConversationBrowserActivity,
} from "../../browser/browser-session-activity-store";
import { useComputerUseWaitText } from "../../agent-control/computer-use-state-store";
import {
  browserActivityGroupLabel,
  browserActivityGroupStatus,
  resolveBrowserActivityPresentation,
  resolveBrowserActionUrls,
  browserActivityUsesWebsiteIcon,
  type AgentControlSurface,
  type BrowserToolActivity,
} from "../../browser/browser-tool-activity";
import type { AgentToolMessage } from "../use-agent-session";
import type { RendererContext } from "./types";
import { NativeBrowserToolRow } from "./event-row-renderer";
import { ToolIdentityIcon } from "./tool-identity-icon";
import { ListRow } from "@/renderer/shared/ui/primitives/list-row";

const MAX_VISIBLE_ACTIONS = 24;

export const BrowserActivityCard = memo(function BrowserActivityCard({
  surface = "browser",
  events,
  actions,
  closed,
  ctx,
}: {
  surface?: AgentControlSurface;
  events: AgentToolMessage[];
  actions: BrowserToolActivity[];
  closed: boolean;
  ctx: RendererContext;
}) {
  const [open, setOpen] = useTurnDisclosure<boolean>(events[0].id, "browser", false);
  const session = useConversationBrowserActivity(ctx.chatId ?? undefined);
  const latest = actions.at(-1);
  const groupStatus = browserActivityGroupStatus(events, closed);
  const running = groupStatus === "browsing";
  // While another chat holds the computer, say whose turn it is instead of
  // the queued action title.
  const computerWaitText = useComputerUseWaitText(
    surface === "computer" ? ctx.chatId : undefined,
  );
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
  const statusLabel = browserActivityGroupLabel(surface, groupStatus);
  const liveTitles =
    running && !computerWaitText
      ? actions
          .filter(
            (action) =>
              action.status === "pending" || action.status === "in_progress",
          )
          .map((action) => action.label)
          .slice(-2)
          .join(" · ") || latest?.label
      : undefined;
  const liveText = running ? (computerWaitText ?? liveTitles) : undefined;

  return (
    <div className="max-w-full" data-browser-activity-count={actions.length}>
      <ListRow
        type="button"
        className="min-w-0 transition-colors"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={statusLabel}
      >
        <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
          <ToolIdentityIcon
            appId={latest?.appId}
            faviconUrl={
              faviconDataUrl ??
              latest?.faviconUrl ??
              (latest?.external && latest.url && hasWebsiteActivity
                ? new URL("/favicon.ico", latest.url).href
                : undefined)
            }
            fallback={
              hasWebsiteActivity
                ? Globe2
                : surface === "simulator"
                  ? Smartphone
                  : SquareMousePointer
            }
            active={ctx.attachmentImagesActive !== false}
            className={
              failed ? "text-red-primary size-3.5" : "text-fg2 size-3.5"
            }
          />
        </span>
        <span className="text-fg1 min-w-0 truncate text-sm">{statusLabel}</span>
        {liveText ? (
          <span className="text-fg2 min-w-0 truncate text-xs">{liveText}</span>
        ) : null}
        <Chevron className="text-fg3 size-3 shrink-0" aria-hidden="true" />
      </ListRow>
      {open ? (
        <div className="border-border1 mt-1 ml-2 flex max-w-[680px] flex-col border-l pl-3">
          {omitted > 0 ? (
            <div className="text-fg3 py-1 text-xs">
              {omitted} earlier {surface} actions condensed
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
