// ──────────────────────────────────────────────────────────
// AI Elements — Message
// ──────────────────────────────────────────────────────────
// Visual primitive for chat messages. Mirrors Vercel AI Elements'
// `Message` shape: role-aware container + content body + optional
// avatar. Built on shadcn primitives + the v0 token surface, so
// hue/intensity/brand sliders flow through automatically.
// ──────────────────────────────────────────────────────────

import * as React from "react";

import { cn } from "@/zeros/ui/cn";

type MessageRole = "user" | "assistant" | "system";

export interface MessageProps extends React.HTMLAttributes<HTMLDivElement> {
  from: MessageRole;
}

const Message = React.forwardRef<HTMLDivElement, MessageProps>(
  ({ className, from, ...props }, ref) => (
    <div
      ref={ref}
      data-role={from}
      className={cn(
        // Assistant + system read left-to-right as editorial body copy.
        // User messages are the exception: their alignment + bubble shape
        // are owned by TurnPromptHeader (right-aligned, fit-to-content), so
        // here the user variant only zeroes the wrapper's vertical padding
        // (py-0) — the bubble already supplies its own px-3 py-2, and the old
        // py-2 doubled it. Content stays left-aligned WITHIN the bubble.
        "group/message flex w-full gap-3 py-2",
        from === "user" && "justify-start py-0",
        from === "assistant" && "justify-start",
        from === "system" && "justify-center",
        className,
      )}
      {...props}
    />
  ),
);
Message.displayName = "Message";

export interface MessageContentProps
  extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "flat";
}

const MessageContent = React.forwardRef<HTMLDivElement, MessageContentProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex flex-col gap-2 overflow-hidden text-sm leading-relaxed",
        // Roadmap 01b post-Wave-3 fix: user bubble now uses bg-bg2
        // + text-fg1 (canonical AI Elements pattern, calm muted
        // surface) instead of bg-primary-button-bg + text-primary-button-fg
        // (which made the user bubble glaringly white in dark mode
        // because --primary inverts to near-white). Assistant +
        // system unchanged.
        variant === "default" &&
          "rounded-sm px-4 py-3 group-data-[role=user]/message:bg-bg2 group-data-[role=user]/message:text-fg1 group-data-[role=assistant]/message:bg-bg2 group-data-[role=assistant]/message:text-fg1 group-data-[role=assistant]/message:border group-data-[role=system]/message:bg-bg2 group-data-[role=system]/message:text-fg2 group-data-[role=system]/message:text-xs",
        variant === "flat" && "text-fg1",
        className,
      )}
      {...props}
    />
  ),
);
MessageContent.displayName = "MessageContent";

export interface MessageAvatarProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  src?: string;
  name?: string;
}

const MessageAvatar = React.forwardRef<HTMLDivElement, MessageAvatarProps>(
  ({ className, src, name, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex size-8 shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-bg2-hover text-xs font-medium text-fg2 ring-1 ring-border1",
        className,
      )}
      {...props}
    >
      {src ? (
        <img src={src} alt={name ?? ""} className="size-full object-cover" />
      ) : (
        (name ?? "?").slice(0, 1).toUpperCase()
      )}
    </div>
  ),
);
MessageAvatar.displayName = "MessageAvatar";

export { Message, MessageContent, MessageAvatar };
