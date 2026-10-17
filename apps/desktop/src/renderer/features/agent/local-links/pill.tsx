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
  chat: "hover:bg-bg1-hover hover:text-fg1",
  workspace:
    "bg-blue-pill-bg text-blue-fg hover:bg-blue-pill-hover hover:text-blue-fg",
  muted: "bg-bg2-hover text-fg3 hover:bg-bg2-highlight hover:text-fg3",
} as const;

export const LocalLinkPill = memo(function LocalLinkPill({
  href,
  fallback,
  className,
}: {
  href: string;
  fallback?: Pick<LocalMessageChatRef, "title" | "agentId">;
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
        data-local-link-agent={agentId ?? undefined}
        data-local-link-available={available}
        aria-label={`Open ${link.kind}: ${label}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={navigate}
        onAuxClick={navigate}
        className={cn(
          link.kind === "chat" ? PILL_SHELL : `${PILL_METRICS} border-0`,
          // The workspace glyph sits closer to its name than a chat logo.
          link.kind === "chat" ? COMPOSER_PILL_SPACING : "gap-1 px-1.5",
          "focus-visible:ring-highlighted-bright min-w-0 shrink-0 py-0 font-normal focus-visible:ring-2 [&_svg]:size-[13px]",
          TINTS[tone],
          className,
        )}
      >
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          {link.kind === "chat" ? (
            <AgentIcon agentId={agentId} iconUrl={null} size={13} />
          ) : link.id.startsWith("folder:") ? (
            <Folder size={13} />
          ) : (
            <WorkspaceGlyph
              seed={target?.glyphSeed ?? link.id}
              size={13}
              className="text-inherit"
            />
          )}
        </span>
        <span className="max-w-[16rem] truncate">{label}</span>
      </Button>
    </Tooltip>
  );
});
