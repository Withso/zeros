import type { ComponentPropsWithoutRef } from "react";
import { ArrowUpRight } from "lucide-react";
import { redactLogSecrets } from "@zeros/protocol/scrub";
import { cn } from "@/renderer/shared/ui/cn";
import { PROMPT_SURFACE_RADIUS } from "./composer-shell";

/** Ghost-button text actions on the notice surface (Retry, Sign in). Hover
 *  drops the ghost fill and pops the label + icon instead (lighter on dark,
 *  deeper in Light — semantic-tokens.css). The button keeps its 6px side
 *  padding for the focus ring and hit area; -mx-1.5 cancels it in layout,
 *  keeping the label aligned with the message text. */
export const AGENT_NOTICE_ACTION =
  "text-brown-fg hover:bg-transparent hover:text-(--agent-notice-action-hover) -mx-1.5";

/** Provider prose is plain text; only explicit web URLs become links. */
export function AgentNoticeText({ message }: { message: string }) {
  const parts = redactLogSecrets(message).split(
    /(https?:\/\/[^\s<>"\]]+[^\s<>"\].,;)])/g,
  );
  return (
    <div className="wrap-anywhere whitespace-pre-wrap">
      {parts.map((part, index) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brown-primary underline underline-offset-2"
          >
            {part}
            <ArrowUpRight className="ml-1 inline size-3.5" aria-hidden="true" />
          </a>
        ) : (
          part
        ),
      )}
    </div>
  );
}

/** Wears the sent user message's shape: sans text, 12px corners and 8px
 *  vertical / 12px horizontal padding. No outer margin: the working feed and
 *  TurnContainer space it with their gaps, and a caller in a gapless stack
 *  (TurnFailureCard) adds its own. */
export function AgentNotice({
  message,
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { message: string }) {
  return (
    <div
      role="status"
      data-agent-notice
      {...props}
      className={cn(
        "bg-brown-bg text-fg1 min-w-0 px-3 py-2 text-sm",
        PROMPT_SURFACE_RADIUS,
        className,
      )}
    >
      <AgentNoticeText message={message} />
      {children}
    </div>
  );
}
