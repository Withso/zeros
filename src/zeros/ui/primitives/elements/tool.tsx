// ──────────────────────────────────────────────────────────
// AI Elements — Tool
// ──────────────────────────────────────────────────────────
// Visual primitive for a tool invocation. Mirrors Vercel AI
// Elements' `Tool` shape: a Collapsible card with a header (icon
// + name + status pill) and a content body that breaks into
// input / output sections.
// ──────────────────────────────────────────────────────────

import * as React from "react";
import {
  CircleCheck,
  CircleX,
  Minus,
  Plus,
} from "lucide-react";

import { ZerosSpinner } from "@/loaders";

import { cn } from "@/zeros/ui/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";

export type ToolStatus =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "running"
  | "complete"
  | "error";

export interface ToolProps
  extends React.ComponentPropsWithoutRef<typeof Collapsible> {}

// 01e Phase 4: borderless, no card chrome. The tool row IS the visible
// element — no shadow, no rounded-lg outer container. Sits in the
// turn-event flow like any other inline message.
const Tool = React.forwardRef<
  React.ComponentRef<typeof Collapsible>,
  ToolProps
>(({ className, ...props }, ref) => (
  <Collapsible
    ref={ref}
    className={cn("w-full text-fg1", className)}
    {...props}
  />
));
Tool.displayName = "Tool";

export interface ToolHeaderProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof CollapsibleTrigger>,
    "title"
  > {
  icon?: React.ReactNode;
  /** Display name of the tool. ReactNode for inline status badges, etc. */
  label: React.ReactNode;
  status?: ToolStatus;
}

function StatusIcon({ status }: { status: ToolStatus }) {
  if (status === "running" || status === "input-streaming") {
    return (
      <ZerosSpinner size={12} variant="agent" label="Running" />
    );
  }
  if (status === "error" || status === "output-error") {
    return <CircleX aria-label="Error" className="size-3 text-red-primary" />;
  }
  return (
    <CircleCheck aria-label="Complete" className="size-3 text-green-primary/80" />
  );
}

// One-line tool row.
//   • h-8 row, no background, hover bumps to bg-bg2-hover/40 (very subtle).
//   • Leading icon at size-4: defaults to the tool's icon. On row hover,
//     icon swaps to "+" (closed) or "−" (open) — the canonical
//     expand-affordance signal.
//   • Label is text-sm font-normal (NOT font-medium — the previous shape
//     made every tool look like a section heading).
//   • Status icon sits trailing, no chevron — the +/- swap is the toggle.
const ToolHeader = React.forwardRef<
  React.ComponentRef<typeof CollapsibleTrigger>,
  ToolHeaderProps
>(({ className, icon, label, status, children, ...props }, ref) => (
  <CollapsibleTrigger
    ref={ref}
    // Width hugs the content (`w-fit`, lane-capped via `max-w-full`) so the
    // hover tint fits the header instead of painting the empty lane to the
    // right (user feedback — hover should fit the content, not exceed).
    className={cn(
      "group/tool-header flex h-8 w-fit min-w-0 max-w-full items-center gap-2 rounded-md px-2 text-left text-sm font-normal text-fg1 transition-colors hover:bg-bg2-hover/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-highlighted-bright",
      className,
    )}
    {...props}
  >
    {icon ? (
      <span
        className="relative flex size-4 shrink-0 items-center justify-center text-fg2 [&_svg]:size-4"
        aria-hidden="true"
      >
        {/* Default state: tool icon. Hidden on hover (any state). */}
        <span className="inline-flex group-hover/tool-header:hidden">
          {icon}
        </span>
        {/* Hover + closed: + */}
        <Plus className="hidden size-3.5 group-hover/tool-header:group-data-[state=closed]/tool-header:inline" />
        {/* Hover + open: − */}
        <Minus className="hidden size-3.5 group-hover/tool-header:group-data-[state=open]/tool-header:inline" />
      </span>
    ) : null}
    <span className="min-w-0 truncate">{label}</span>
    {status ? <StatusIcon status={status} /> : null}
    {children}
  </CollapsibleTrigger>
));
ToolHeader.displayName = "ToolHeader";

// 01e Phase 4: borderless body, indented under the row's label so the
// expanded body visually belongs to its row. No top-border — whitespace
// is the only separator.
const ToolContent = React.forwardRef<
  React.ComponentRef<typeof CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsibleContent>
>(({ className, ...props }, ref) => (
  <CollapsibleContent
    ref={ref}
    className={cn(
      "overflow-hidden text-sm data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down",
      className,
    )}
    {...props}
  />
));
ToolContent.displayName = "ToolContent";

const ToolInput = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "border-b bg-bg2/60 px-3 py-2 font-mono text-xs leading-relaxed [&_pre]:m-0 [&_pre]:bg-transparent [&_pre]:p-0",
      className,
    )}
    {...props}
  />
));
ToolInput.displayName = "ToolInput";

const ToolOutput = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "px-3 py-2 text-xs leading-relaxed [&_pre]:m-0 [&_pre]:bg-transparent [&_pre]:p-0",
      className,
    )}
    {...props}
  />
));
ToolOutput.displayName = "ToolOutput";

export { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput };
