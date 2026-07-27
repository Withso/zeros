// ──────────────────────────────────────────────────────────
// AI Elements — Suggestion / Suggestions
// ──────────────────────────────────────────────────────────
// Vendored from vercel/ai-elements@1.9.0 during Roadmap 01b Wave 4
// (2026-05-16). Single file, no extra deps beyond Button + ScrollArea
// which we already ship. The canonical chip-row pattern: horizontally
// scrollable ScrollArea wrapping an inline-flex row of Button-shaped
// pills (size="sm" + variant="secondary" + rounded-full + px-4).
// ──────────────────────────────────────────────────────────

import { Button } from "@/zeros/ui/primitives/button";
import { ScrollArea, ScrollBar } from "@/zeros/ui/primitives/scroll-area";
import { cn } from "@/zeros/ui/cn";
import type { ComponentProps } from "react";
import { useCallback } from "react";

export type SuggestionsProps = ComponentProps<typeof ScrollArea>;

export const Suggestions = ({
  className,
  children,
  ...props
}: SuggestionsProps) => (
  <ScrollArea className="w-full overflow-x-auto whitespace-nowrap" {...props}>
    <div className={cn("flex w-max flex-nowrap items-center gap-2", className)}>
      {children}
    </div>
    <ScrollBar className="hidden" orientation="horizontal" />
  </ScrollArea>
);

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = "secondary",
  size = "sm",
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = useCallback(() => {
    onClick?.(suggestion);
  }, [onClick, suggestion]);

  return (
    <Button
      className={cn("cursor-pointer rounded-sm px-4", className)}
      onClick={handleClick}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      {children || suggestion}
    </Button>
  );
};
