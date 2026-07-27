// AI Elements — PromptInput
// ────────────────────────────────────────────────────────────────
// Canonical AI Elements PromptInput recipe = a single InputGroup
// with the textarea body + one or two InputGroupAddon rows for
// the toolbar (model / effort / branch / send button etc).
//
// Vercel's prompt-input.tsx ships as a form-element wrapper that
// owns `value` + onChange + onSubmit. We expose just the visual
// recipe (the `<form>` and `value` plumbing stay with the caller
// because each composer surface in Zeros has its own state shape:
// EmptyComposer holds a draft in the workspace store; AgentChat
// drives a per-thread draft).
//
// Recipe:
//   <PromptInput onSubmit={...}>
//     <PromptInputBody>
//       <PromptInputTextarea value={...} onChange={...} />
//       <PromptInputToolbar>
//         <PromptInputTools>… left-side chips …</PromptInputTools>
//         <PromptInputSubmit status={...} />
//       </PromptInputToolbar>
//     </PromptInputBody>
//   </PromptInput>
//
// Wave 4 — Roadmap 01b.

import * as React from "react";
import { ArrowUp, Square } from "lucide-react";
import { ZerosSpinner } from "@/loaders";

import { Button } from "@/zeros/ui/primitives/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@/zeros/ui/primitives/input-group";
import { cn } from "@/zeros/ui/cn";

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

export interface PromptInputBodyProps
  extends React.ComponentProps<typeof InputGroup> {}

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

export interface PromptInputTextareaProps
  extends React.ComponentProps<typeof InputGroupTextarea> {}

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

export interface PromptInputToolbarProps
  extends React.ComponentProps<typeof InputGroupAddon> {}

const PromptInputToolbar = React.forwardRef<HTMLDivElement, PromptInputToolbarProps>(
  function PromptInputToolbar({ className, ...props }, ref) {
    return (
      <InputGroupAddon
        ref={ref as React.Ref<HTMLDivElement>}
        align="block-end"
        data-slot="prompt-input-toolbar"
        className={cn("justify-between gap-2", className)}
        {...props}
      />
    );
  },
);

export interface PromptInputToolsProps extends React.HTMLAttributes<HTMLDivElement> {}

const PromptInputTools = React.forwardRef<HTMLDivElement, PromptInputToolsProps>(
  function PromptInputTools({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="prompt-input-tools"
        className={cn("flex flex-wrap items-center gap-1", className)}
        {...props}
      />
    );
  },
);

export type PromptInputStatus =
  | "ready"
  | "submitted"
  | "streaming"
  | "error";

export interface PromptInputSubmitProps
  extends React.ComponentProps<typeof Button> {
  status?: PromptInputStatus;
}

const PromptInputSubmit = React.forwardRef<HTMLButtonElement, PromptInputSubmitProps>(
  function PromptInputSubmit(
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
        // 2026-07-10 (user spec): the send/stop button squares off to a 4px
        // radius (was the stock recipe's rounded-full circle).
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
  },
);

export {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
  PromptInputSubmit,
};
