import type { ComponentPropsWithoutRef } from "react";
import { ArrowUpRight } from "lucide-react";
import { redactLogSecrets } from "@zeros/protocol/scrub";
import { cn } from "@/renderer/shared/ui/cn";

/** Provider prose is plain text; only explicit web URLs become links. */
export function AgentNoticeText({ message }: { message: string }) {
  const parts = redactLogSecrets(message).split(
    /(https?:\/\/[^\s<>"\]]+[^\s<>"\].,;)])/g,
  );
  return (
    <div className="font-mono wrap-anywhere whitespace-pre-wrap">
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
        "bg-brown-bg text-fg1 my-2 min-w-0 rounded-md p-3 text-sm",
        className,
      )}
    >
      <AgentNoticeText message={message} />
      {children}
    </div>
  );
}
