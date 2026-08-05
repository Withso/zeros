// Portions adapted from vercel/ai-elements@1.9.0 (Apache-2.0) and modified
// for Zeros; see third_party/ai-elements/LICENSE. Parent surfaces own scroll
// state, so this local composition intentionally remains dependency-free.

import * as React from "react";
import { ArrowDown } from "lucide-react";

import { Button } from "@/renderer/shared/ui/primitives/button";
import { cn } from "@/renderer/shared/ui/cn";

export interface ConversationProps extends React.HTMLAttributes<HTMLDivElement> {}

const Conversation = React.forwardRef<HTMLDivElement, ConversationProps>(
  function Conversation({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="conversation"
        className={cn(
          "relative flex min-h-0 flex-1 flex-col overflow-hidden",
          className,
        )}
        {...props}
      />
    );
  },
);

export interface ConversationContentProps extends React.HTMLAttributes<HTMLDivElement> {}

const ConversationContent = React.forwardRef<
  HTMLDivElement,
  ConversationContentProps
>(function ConversationContent({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      data-slot="conversation-content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4",
        className,
      )}
      {...props}
    />
  );
});

export interface ConversationScrollButtonProps extends React.ComponentProps<
  typeof Button
> {}

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
