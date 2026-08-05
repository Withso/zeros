// Portions adapted from vercel/ai-elements@1.9.0 (Apache-2.0) and modified
// for Zeros; see third_party/ai-elements/LICENSE. This component provides the
// visual form composition while each caller continues to own its draft state.

import * as React from "react";
import { ArrowUp, Square } from "lucide-react";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";

import { Button } from "@/renderer/shared/ui/primitives/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@/renderer/shared/ui/primitives/input-group";
import { cn } from "@/renderer/shared/ui/cn";

export interface PromptInputProps extends React.FormHTMLAttributes<HTMLFormElement> {}

const PromptInput = React.forwardRef<HTMLFormElement, PromptInputProps>(
  function PromptInput({ className, ...props }, ref) {
    return (
      <form
        ref={ref}
        data-slot="prompt-input"
        className={cn("w-full", className)}
        {...props}
      />
    );
  },
);

export interface PromptInputBodyProps extends React.ComponentProps<
  typeof InputGroup
> {}

const PromptInputBody = React.forwardRef<HTMLDivElement, PromptInputBodyProps>(
  function PromptInputBody({ className, ...props }, ref) {
    return (
      <InputGroup
        ref={ref as React.Ref<HTMLDivElement>}
        data-slot="prompt-input-body"
        className={cn("flex-col", className)}
        {...props}
      />
    );
  },
);

export interface PromptInputTextareaProps extends React.ComponentProps<
  typeof InputGroupTextarea
> {}

const PromptInputTextarea = React.forwardRef<
  HTMLTextAreaElement,
  PromptInputTextareaProps
>(function PromptInputTextarea({ className, ...props }, ref) {
  return (
    <InputGroupTextarea
      ref={ref}
      data-slot="prompt-input-textarea"
      className={cn("min-h-12", className)}
      {...props}
    />
  );
});

export interface PromptInputToolbarProps extends React.ComponentProps<
  typeof InputGroupAddon
> {}

const PromptInputToolbar = React.forwardRef<
  HTMLDivElement,
  PromptInputToolbarProps
>(function PromptInputToolbar({ className, ...props }, ref) {
  return (
    <InputGroupAddon
      ref={ref as React.Ref<HTMLDivElement>}
      align="block-end"
      data-slot="prompt-input-toolbar"
      className={cn("justify-between gap-2", className)}
      {...props}
    />
  );
});

export interface PromptInputToolsProps extends React.HTMLAttributes<HTMLDivElement> {}

const PromptInputTools = React.forwardRef<
  HTMLDivElement,
  PromptInputToolsProps
>(function PromptInputTools({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      data-slot="prompt-input-tools"
      className={cn("flex flex-wrap items-center gap-1", className)}
      {...props}
    />
  );
});

export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

export interface PromptInputSubmitProps extends React.ComponentProps<
  typeof Button
> {
  status?: PromptInputStatus;
}

const PromptInputSubmit = React.forwardRef<
  HTMLButtonElement,
  PromptInputSubmitProps
>(function PromptInputSubmit(
  { className, status = "ready", disabled, children, ...props },
  ref,
) {
  const isBusy = status === "submitted" || status === "streaming";
  return (
    <Button
      ref={ref}
      type="submit"
      size="icon"
      data-slot="prompt-input-submit"
      data-status={status}
      disabled={disabled ?? (isBusy && status === "submitted")}
      // The send/stop button uses a 4px radius rather than the stock recipe's
      // rounded-full circle.
      className={cn("size-7 rounded-sm", className)}
      aria-label={isBusy ? "Submitting" : "Send message"}
      {...props}
    >
      {children ??
        (status === "streaming" ? (
          <Square className="size-3 fill-current" />
        ) : isBusy ? (
          <ZerosSpinner size={16} />
        ) : (
          <ArrowUp className="size-3.5" />
        ))}
    </Button>
  );
});

export {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
  PromptInputSubmit,
};
