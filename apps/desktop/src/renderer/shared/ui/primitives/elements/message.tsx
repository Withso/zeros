// Portions adapted from vercel/ai-elements@1.9.0 (Apache-2.0) and modified
// for Zeros; see third_party/ai-elements/LICENSE. The local primitive keeps a
// role-aware container, content body, and optional avatar on shared tokens.

import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";

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

export interface MessageContentProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "flat";
}

const MessageContent = React.forwardRef<HTMLDivElement, MessageContentProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex flex-col gap-2 overflow-hidden text-sm leading-relaxed",
        // User bubbles use a calm raised surface instead of the inverted
        // primary-action colors, which would be too bright in dark mode.
        variant === "default" &&
          "group-data-[role=user]/message:bg-bg2 group-data-[role=user]/message:text-fg1 group-data-[role=assistant]/message:bg-bg2 group-data-[role=assistant]/message:text-fg1 group-data-[role=system]/message:bg-bg2 group-data-[role=system]/message:text-fg2 rounded-sm px-4 py-3 group-data-[role=assistant]/message:border group-data-[role=system]/message:text-xs",
        variant === "flat" && "text-fg1",
        className,
      )}
      {...props}
    />
  ),
);
MessageContent.displayName = "MessageContent";

export interface MessageAvatarProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children"
> {
  src?: string;
  name?: string;
}

const MessageAvatar = React.forwardRef<HTMLDivElement, MessageAvatarProps>(
  ({ className, src, name, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "bg-bg2-hover text-fg2 ring-border1 flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-medium ring-1 select-none",
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
