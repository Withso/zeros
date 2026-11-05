import { memo, type MouseEvent } from "react";
import { Folder } from "lucide-react";
import { parseLocalLink } from "@zeros/protocol/local-orchestration";
import type { LocalMessageChatRef } from "@zeros/protocol/agent-messages";
import { Button } from "../../../shared/ui/primitives/button";
import { Tooltip } from "../../../shared/ui/primitives/tooltip";
import { cn } from "../../../shared/ui/cn";
import { WorkspaceGlyph } from "../../../shell/workspace-glyph";
import { AgentIcon } from "../agent-icon";
import {
  COMPOSER_PILL_SPACING,
  PILL_METRICS,
  PILL_SHELL,
} from "../composer-editor/pill-views";
import { useLocalLinks } from "./context";

const TINTS = {
  chat: "hover:border-border3 hover:bg-bg2-highlight hover:text-fg1",
  workspace:
    "bg-blue-pill-bg text-blue-fg hover:bg-blue-pill-hover hover:text-blue-fg",
  muted: "bg-bg2-hover text-fg3 hover:bg-bg2-highlight hover:text-fg3",
} as const;

/** The caret's selection in the composer: a fill, never a ring. The workspace
 * pill keeps its blue, one step up. */
const SELECTED = {
  chat: "bg-selected-bg hover:bg-selected-bg",
  workspace: "bg-blue-pill-hover",
  muted: "bg-selected-bg hover:bg-selected-bg",
} as const;

/** A sender line's text holds its tone hovered too: only the name's fill
 * changes. A target that is gone reads fg3. */
const SENDER = {
  chat: "text-fg1 hover:text-fg1",
  workspace: "text-fg1 hover:text-fg1",
  muted: "text-fg3 hover:text-fg3",
} as const;

export const LocalLinkPill = memo(function LocalLinkPill({
  href,
  fallback,
  selected = false,
  appearance = "pill",
  className,
}: {
  href: string;
  fallback?: Pick<LocalMessageChatRef, "title" | "agentId">;
  /** The composer's node selection is on this pill. */
  selected?: boolean;
  /** `sender`: the line above a message another chat sent, as in a chat app:
   *  the name, then a 16px logo, with no pill. On hover only the name takes
   *  the bg1-hover fill (the pane's own hover), with no border. */
  appearance?: "pill" | "sender";
  className?: string;
}) {
  const context = useLocalLinks();
  const link = parseLocalLink(href);
  if (!context.enabled || !link || link.scheme !== context.scheme)
    return <>{href}</>;
  const target = (
    link.kind === "chat" ? context.index?.chats : context.index?.workspaces
  )?.get(link.id);
  const available = target?.available === true;
  const label =
    (available ? target.label : fallback?.title) ||
    (link.kind === "chat" ? "Chat" : "Workspace");
  const agentId = available ? target.agentId : fallback?.agentId;
  const tone = !available
    ? "muted"
    : link.kind === "workspace"
      ? "workspace"
      : "chat";
  const navigate = (event: MouseEvent) => {
    if (event.type === "auxclick" && event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    context.navigate(href);
  };
  const sender = appearance === "sender";
  const glyphSize = sender ? 16 : 13;
  const glyph = (
    <span
      className="inline-flex size-4 shrink-0 items-center justify-center"
      aria-hidden="true"
    >
      {link.kind === "chat" ? (
        <AgentIcon agentId={agentId} iconUrl={null} size={glyphSize} />
      ) : link.id.startsWith("folder:") ? (
        <Folder size={glyphSize} />
      ) : (
        <WorkspaceGlyph
          seed={target?.glyphSeed ?? link.id}
          size={glyphSize}
          className="text-inherit"
        />
      )}
    </span>
  );
  const name = (
    <span
      data-local-link-label=""
      className={cn(
        "max-w-[16rem] truncate",
        sender && "group-hover/sender:bg-bg1-hover rounded-sm px-1 py-px",
      )}
    >
      {label}
    </span>
  );
  return (
    <Tooltip
      label={
        available ? `${label} — ${href}` : `Unavailable ${link.kind} — ${href}`
      }
    >
      <Button
        variant="ghost"
        type="button"
        data-local-link-pill={link.kind}
        data-local-link-appearance={sender ? "sender" : undefined}
        data-local-link-agent={agentId ?? undefined}
        data-local-link-available={available}
        aria-label={`Open ${link.kind}: ${label}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={navigate}
        onAuxClick={navigate}
        className={cn(
          sender
            ? [
                "group/sender min-w-0 shrink-0 items-center gap-0.5 rounded-sm border-0 bg-transparent p-0 font-normal hover:bg-transparent",
                "focus-visible:ring-highlighted-bright focus-visible:ring-2 [&_svg]:size-4",
                SENDER[tone],
              ]
            : [
                link.kind === "chat" ? PILL_SHELL : `${PILL_METRICS} border-0`,
                // The workspace glyph sits closer to its name than a chat logo.
                link.kind === "chat" ? COMPOSER_PILL_SPACING : "gap-1 px-1.5",
                "focus-visible:ring-highlighted-bright min-w-0 shrink-0 py-0 font-normal focus-visible:ring-2 [&_svg]:size-[13px]",
                TINTS[tone],
                selected && SELECTED[tone],
              ],
          className,
        )}
      >
        {sender ? (
          <>
            {name}
            {glyph}
          </>
        ) : (
          <>
            {glyph}
            {name}
          </>
        )}
      </Button>
    </Tooltip>
  );
});
