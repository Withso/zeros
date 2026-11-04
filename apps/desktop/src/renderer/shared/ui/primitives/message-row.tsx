import * as React from "react";
import { CheckCircle2, CircleAlert, Info, TriangleAlert, type LucideIcon } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import { ZerosSpinner } from "@/renderer/shared/ui/loading/zeros-spinner";

export type MessageTone = "error" | "warning" | "success" | "neutral" | "pending";

const ICON: Record<Exclude<MessageTone, "pending">, LucideIcon> = {
  error: CircleAlert,
  warning: TriangleAlert,
  success: CheckCircle2,
  neutral: Info,
};

const ICON_TONE: Record<Exclude<MessageTone, "pending">, string> = {
  error: "text-red-primary",
  warning: "text-yellow-primary",
  success: "text-green-primary",
  neutral: "text-fg3",
};

export interface MessageRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  tone?: MessageTone;
  /** One line; it truncates rather than wraps. */
  children: React.ReactNode;
  /** Trailing 24px Ghost buttons, such as Retry. */
  actions?: React.ReactNode;
  /** A border1 rule below, for a row under a toolbar. */
  bar?: boolean;
  /** No side padding, for a row inside an already-padded card. */
  flush?: boolean;
}

/** The one message row (the Banner spec): 32px on the surface it sits on,
 * a 16px icon carries the tone, 13/18 fg2 text on one line and Ghost actions
 * at the end. No fill, no close and no timer. */
export function MessageRow({
  tone = "neutral",
  children,
  actions,
  bar = false,
  flush = false,
  className,
  title,
  ...props
}: MessageRowProps) {
  const Icon = tone === "pending" ? null : ICON[tone];
  return (
    <div
      data-slot="message-row"
      data-tone={tone}
      className={cn(
        "text-fg2 flex min-h-8 w-full min-w-0 items-center gap-2 text-xs leading-4.5",
        flush ? "px-0" : "pr-1.5 pl-3",
        bar && "border-border1 border-b",
        className,
      )}
      {...props}
    >
      {Icon ? (
        <Icon aria-hidden className={cn("size-4 shrink-0", ICON_TONE[tone as Exclude<MessageTone, "pending">])} />
      ) : (
        <ZerosSpinner size={16} label="Loading" />
      )}
      <span
        className="min-w-0 flex-1 truncate"
        title={title ?? (typeof children === "string" ? children : undefined)}
      >
        {children}
      </span>
      {actions ? (
        <span className="flex shrink-0 items-center gap-1 [&_button]:text-fg2">
          {actions}
        </span>
      ) : null}
    </div>
  );
}
