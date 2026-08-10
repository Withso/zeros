import { Target } from "lucide-react";

import type { NativeThreadGoal } from "../../platform/bridge/agent-events";
import { cn } from "../../shared/ui/cn";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from "../../shared/ui/primitives";
import { formatTokens } from "./context-gauge";

const STATUS_LABEL: Record<NativeThreadGoal["status"], string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget limited",
  complete: "Complete",
};

/** Compact, native Codex goal state beside the context gauge. The goal remains
 * provider-owned; this surface reflects updates without inventing a parallel
 * Zeros lifecycle. */
export function NativeGoalPill({ goal }: { goal: NativeThreadGoal | null }) {
  if (!goal) return null;
  const critical = goal.status === "blocked" || goal.status === "budgetLimited";
  const usage = goal.tokenBudget
    ? `${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)} tokens`
    : `${formatTokens(goal.tokensUsed)} tokens used`;

  return (
    <Popover>
      <Tooltip label={`Goal · ${STATUS_LABEL[goal.status]}`}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Codex goal: ${goal.objective}`}
            className={cn(
              "text-fg2 hover:bg-bg4 inline-flex h-7 max-w-36 items-center gap-1 rounded-md px-1.5 text-[11px]",
              critical && "text-red-primary",
            )}
          >
            <Target size={13} aria-hidden="true" />
            <span className="truncate">{STATUS_LABEL[goal.status]}</span>
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" side="top" className="w-72 p-3">
        <div className="text-fg text-xs font-medium">Codex goal</div>
        <div className="text-fg mt-2 text-sm leading-5">{goal.objective}</div>
        <div className="text-fg2 mt-2 flex justify-between text-xs">
          <span>{STATUS_LABEL[goal.status]}</span>
          <span>{usage}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
