import React, { useEffect, useState } from "react";
import type { AgentGoal } from "@zeros/protocol/agent-events";
import { Check, Pause, Pencil, Play, Target, Trash2, X } from "lucide-react";

import { Button, Textarea } from "../../shared/ui";

interface GoalCardProps {
  goal: AgentGoal | null;
  editing: boolean;
  onEditingChange(editing: boolean): void;
  onSave(objective: string): Promise<void>;
  onStatus(status: "active" | "paused"): Promise<void>;
  onDelete(): Promise<void>;
}

function statusLabel(status: AgentGoal["status"]): string {
  switch (status) {
    case "active":
      return "Pursuing goal";
    case "paused":
      return "Goal paused";
    case "blocked":
      return "Goal blocked";
    case "usageLimited":
      return "Goal usage limited";
    case "budgetLimited":
      return "Goal budget limited";
    case "complete":
      return "Goal complete";
  }
}

/** Compact, provider-neutral goal row above the composer. Native goal protocol
 * details stay in the engine adapter; this surface edits only product fields. */
export function GoalCard({
  goal,
  editing,
  onEditingChange,
  onSave,
  onStatus,
  onDelete,
}: GoalCardProps) {
  const [draft, setDraft] = useState(goal?.objective ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (editing) setDraft(goal?.objective ?? "");
  }, [editing, goal?.objective]);

  const run = async (operation: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      await operation();
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!editing && !goal) return null;
  const currentGoal = goal;

  return (
    <div className="border-border1 bg-bg1 flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 shadow-xs">
      <Target className="text-fg2 size-4 shrink-0" aria-hidden="true" />
      {editing ? (
        <form
          className="flex min-w-0 flex-1 items-start gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const objective = draft.trim();
            if (!objective) return;
            void run(() => onSave(objective)).then((saved) => {
              if (saved) onEditingChange(false);
            });
          }}
        >
          <Textarea
            autoFocus
            value={draft}
            maxLength={4_000}
            rows={2}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="What should Codex pursue?"
            aria-label="Goal objective"
            className="min-h-16 min-w-0 flex-1 resize-none text-sm"
          />
          <Button
            type="submit"
            size="icon-sm"
            variant="ghost"
            disabled={busy || draft.trim().length === 0}
            aria-label="Save goal"
            title="Save goal"
          >
            <Check className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onEditingChange(false)}
            aria-label="Cancel goal edit"
            title="Cancel"
          >
            <X className="size-4" />
          </Button>
        </form>
      ) : (
        currentGoal && (
          <>
            <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="text-fg1 shrink-0 text-sm font-medium">
                {statusLabel(currentGoal.status)}
              </span>
              <span className="text-fg2 min-w-0 flex-1 truncate text-sm">
                {currentGoal.objective}
              </span>
              {currentGoal.tokenBudget != null ? (
                <span className="text-muted-fg shrink-0 text-xs tabular-nums">
                  {currentGoal.tokensUsed.toLocaleString()} /{" "}
                  {currentGoal.tokenBudget.toLocaleString()} tokens
                </span>
              ) : null}
            </div>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  onStatus(
                    currentGoal.status === "active" ? "paused" : "active",
                  ),
                )
              }
              aria-label={
                currentGoal.status === "active" ? "Pause goal" : "Resume goal"
              }
              title={
                currentGoal.status === "active" ? "Pause goal" : "Resume goal"
              }
            >
              {currentGoal.status === "active" ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onEditingChange(true)}
              aria-label="Edit goal"
              title="Edit goal"
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(onDelete)}
              aria-label="Delete goal"
              title="Delete goal"
            >
              <Trash2 className="size-4" />
            </Button>
          </>
        )
      )}
    </div>
  );
}
