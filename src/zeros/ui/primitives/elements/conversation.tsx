// AI Elements — Conversation
// ────────────────────────────────────────────────────────────────
// Canonical AI Elements Conversation = vertically-stacked scroll
// container that pins to the bottom on new messages. Vercel's
// reference implementation pulls in `use-stick-to-bottom` for
// auto-scroll. We keep it dependency-free here: the parent (Agent
// Chat / Empty Composer) already manages its own scroll behavior.
//
// We only own the visual shape:
//   <Conversation>          → relative flex column, flex-1, min-h-0
//   <ConversationContent>   → inner scroll container, gap, padding
//   <ConversationScrollButton> → optional jump-to-bottom affordance
//
// Wave 4 — Roadmap 01b.

import * as React from "react";
import { ArrowDown } from "lucide-react";

import { Button } from "@/zeros/ui/primitives/button";
import { cn } from "@/zeros/ui/cn";

export interface ConversationProps extends React.HTMLAttributes<HTMLDivElement> {}

const Conversation = React.forwardRef<HTMLDivElement, ConversationProps>(
  function Conversation({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="conversation"
        className={cn(
          "relative flex flex-1 flex-col min-h-0 overflow-hidden",
          className,
        )}
        {...props}
      />
    );
  },
);

export interface ConversationContentProps
  extends React.HTMLAttributes<HTMLDivElement> {}

const ConversationContent = React.forwardRef<
  HTMLDivElement,
  ConversationContentProps
>(function ConversationContent({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      data-slot="conversation-content"
      className={cn(
        "flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto p-4",
        className,
      )}
      {...props}
    />
  );
});

export interface ConversationScrollButtonProps
  extends React.ComponentProps<typeof Button> {}

const ConversationScrollButton = React.forwardRef<
  HTMLButtonElement,
  ConversationScrollButtonProps
>(function ConversationScrollButton({ className, children, ...props }, ref) {
  return (
    <Button
      ref={ref}
      data-slot="conversation-scroll-button"
      variant="secondary"
      size="icon-lg"
      className={cn(
        "absolute right-4 bottom-4 z-10 rounded-sm shadow-[var(--shadow-dropdown)]",
        className,
      )}
      {...props}
    >
      {children ?? <ArrowDown className="size-4" />}
      <span className="sr-only">Scroll to bottom</span>
    </Button>
  );
});

export { Conversation, ConversationContent, ConversationScrollButton };
