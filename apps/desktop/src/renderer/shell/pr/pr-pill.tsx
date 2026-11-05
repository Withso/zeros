import type { MouseEvent } from "react";

import { cn } from "../../shared/ui/cn";
import { Tooltip } from "../../shared/ui/primitives/tooltip";
import type { WorkspacePrTone } from "../workspace-glyph";

// --- CONSTANTS ---

// The PR status island's #N chip as one 24px pill: a quiet outline in the
// PR's colour, the same --pr-status-chip-border-* ramp shades the island uses.
// Conflicts keep the open colour, as the island's chip does.
const PR_PILL_TONE: Record<WorkspacePrTone, string> = {
  open: "border-(--pr-status-chip-border-active) text-brown-primary hover:text-brown-fg",
  conflicts: "border-(--pr-status-chip-border-active) text-brown-primary hover:text-brown-fg",
  ready: "border-(--pr-status-chip-border-success) text-green-primary hover:text-green-fg",
  merged: "border-(--pr-status-chip-border-merged) text-violet-fg hover:text-violet-primary",
  closed: "border-(--pr-status-chip-border-closed) text-red-fg hover:text-red-primary",
};

export const PR_PILL_CLS =
  "inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-3xxs leading-4 font-medium tabular-nums transition-colors duration-120 ease-out focus-visible:ring-[3px] focus-visible:ring-highlighted-bright/50 focus-visible:outline-none";

// --- COMPONENT ---

/** A workspace's PR number, opening the PR on GitHub. One anatomy for Home
 * cards, Home list rows, the repository page and the workspace hover card:
 * no link icon, the state is the colour. */
export function PrPill({
  number,
  url,
  tone,
  className,
}: {
  number: number;
  url: string;
  tone: WorkspacePrTone;
  className?: string;
}) {
  return (
    <Tooltip label="Open PR">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open PR #${number}`}
        data-pr-tone={tone}
        // Cards and rows open their workspace on click; the pill opens the PR.
        onClick={(event: MouseEvent) => event.stopPropagation()}
        className={cn(PR_PILL_CLS, PR_PILL_TONE[tone], className)}
      >
        #{number}
      </a>
    </Tooltip>
  );
}
