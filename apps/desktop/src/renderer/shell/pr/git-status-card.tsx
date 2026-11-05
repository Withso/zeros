// ──────────────────────────────────────────────────────────
// GitStatusCard — Review Overview's branch-on-this-machine card
// ──────────────────────────────────────────────────────────
//
// One line saying how the branch stands, its one action beside it, and a
// chevron that opens the full checklist. The PR status island renders it in
// its git-status presentation, so the action runs through the island's own
// claim, agent-working gate and optimistic update.

import React, { useState } from "react";
import { ChevronDown, CircleCheck, CircleDot, GitMerge } from "lucide-react";

import { Button, IconButton, Tooltip } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import type { PrIslandAction, PrIslandState } from "./pr-status";

/** Review Overview's card: sidebar-bg on border2 with 8px corners. */
export const STATUS_CARD = "border-border2 bg-sidebar-bg min-w-0 rounded-lg border";

const TONE_ICON: Record<string, { icon: typeof CircleCheck; className: string }> = {
  success: { icon: CircleCheck, className: "text-green-primary" },
  warning: { icon: GitMerge, className: "text-yellow-icon" },
  danger: { icon: GitMerge, className: "text-red-primary" },
  neutral: { icon: CircleDot, className: "text-fg3" },
};

export interface GitStatusChecklist {
  uncommitted: number | null;
  ahead: number | null;
  behind: number | null;
  conflicts: boolean | null;
  behindBase: number | null;
  baseBranch: string;
}

function countLine(n: number | null, one: string, many: string): string {
  if (n == null) return "Unknown";
  if (n === 0) return "None";
  return `${n} ${n === 1 ? one : many}`;
}

export function GitStatusCard({
  state,
  checklist,
  actionState,
  onAction,
}: {
  state: PrIslandState | null;
  checklist: GitStatusChecklist;
  /** Per action: running (spinner), disabled and the reason it waits. */
  actionState: (action: PrIslandAction) => { running: boolean; disabled: boolean; reason: string | null };
  onAction: (action: PrIslandAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const tone = TONE_ICON[state?.tone ?? "neutral"] ?? TONE_ICON.neutral;
  const rows: [string, string][] = [
    ["Uncommitted changes", countLine(checklist.uncommitted, "file", "files")],
    ["Commits to push", countLine(checklist.ahead, "commit", "commits")],
    ["Commits to pull", countLine(checklist.behind, "commit", "commits")],
    ["Conflicts", checklist.conflicts == null ? "Unknown" : checklist.conflicts ? "Yes" : "None"],
    [
      `Against ${checklist.baseBranch}`,
      checklist.behindBase && checklist.behindBase > 0
        ? `${checklist.behindBase} ${checklist.behindBase === 1 ? "commit" : "commits"} behind`
        : "Up to date",
    ],
  ];
  return (
    <div data-review-git-status={state?.kind ?? "loading"} className={STATUS_CARD} aria-busy={!state || undefined}>
      <div className="flex min-h-13 min-w-0 items-center gap-2.5 py-2.5 pr-2.5 pl-3.5">
        <tone.icon aria-hidden className={cn("size-4 shrink-0", tone.className)} />
        <span className="text-fg1 min-w-0 flex-1 truncate text-xs font-medium">
          {state?.label ?? "Reading the branch…"}
        </span>
        {(state?.actions ?? []).map((action) => {
          const { running, disabled, reason } = actionState(action);
          const button = (
            <Button
              variant="secondary"
              loading={running}
              disabled={disabled}
              onClick={() => onAction(action)}
            >
              {action.label}
            </Button>
          );
          return reason ? (
            <Tooltip key={action.kind} label={reason}>
              {/* The span keeps the tooltip live over the disabled button. */}
              <span className="inline-flex shrink-0">{button}</span>
            </Tooltip>
          ) : (
            <React.Fragment key={action.kind}>{button}</React.Fragment>
          );
        })}
        <IconButton
          size="compact"
          label={open ? "Hide Git details" : "Show Git details"}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="text-fg3"
        >
          <ChevronDown aria-hidden className={cn("transition-transform", open && "rotate-180")} />
        </IconButton>
      </div>
      {open ? (
        <dl data-review-git-checklist="" className="border-border1 m-0 border-t px-3.5 py-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex min-h-7 items-center gap-3 text-3xxs leading-4">
              <dt className="text-fg3 min-w-0 flex-1 truncate">{label}</dt>
              <dd className="text-fg1 m-0 shrink-0 tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
