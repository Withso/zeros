// ──────────────────────────────────────────────────────────
// AI Elements — Reasoning
// ──────────────────────────────────────────────────────────
// Collapsible visual primitive for agent reasoning / "thinking"
// content. Mirrors Vercel AI Elements' `Reasoning`.
// ──────────────────────────────────────────────────────────

import * as React from "react";
import { Brain, ChevronDown } from "lucide-react";

import { cn } from "@/zeros/ui/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";

const Reasoning = React.forwardRef<
  React.ComponentRef<typeof Collapsible>,
  React.ComponentPropsWithoutRef<typeof Collapsible>
>(({ className, ...props }, ref) => (
  <Collapsible
    ref={ref}
    className={cn("group/reasoning w-full text-sm", className)}
    {...props}
  />
));
Reasoning.displayName = "Reasoning";

export interface ReasoningTriggerProps
  extends React.ComponentPropsWithoutRef<typeof CollapsibleTrigger> {
  label?: React.ReactNode;
}

const ReasoningTrigger = React.forwardRef<
  React.ComponentRef<typeof CollapsibleTrigger>,
  ReasoningTriggerProps
>(({ className, label = "Thinking", children, ...props }, ref) => (
  <CollapsibleTrigger
    ref={ref}
    className={cn(
      "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs font-medium text-fg2 transition-colors hover:bg-bg2-hover/50 hover:text-fg1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-highlighted-bright",
      className,
    )}
    {...props}
  >
    <Brain className="size-3.5 shrink-0" aria-hidden />
    <span className="flex-1 truncate">{label}</span>
    {children}
    <ChevronDown className="size-3.5 shrink-0 transition-transform group-data-[state=open]/reasoning:rotate-180" />
  </CollapsibleTrigger>
));
ReasoningTrigger.displayName = "ReasoningTrigger";

const ReasoningContent = React.forwardRef<
  React.ComponentRef<typeof CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsibleContent>
>(({ className, ...props }, ref) => (
  <CollapsibleContent
    ref={ref}
    className={cn(
      "overflow-hidden text-xs leading-relaxed text-fg2 data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down",
      className,
    )}
    {...props}
  />
));
ReasoningContent.displayName = "ReasoningContent";

export { Reasoning, ReasoningTrigger, ReasoningContent };
