// ──────────────────────────────────────────────────────────
// PlanReviewCard — plan-review actions, a standalone card above the composer
// ──────────────────────────────────────────────────────────
//
// Claude's ExitPlanMode is plan REVIEW, not a permission gate. A permission
// card is a blocking Yes/No that REPLACES the composer; plan review keeps the
// composer live. So while a plan is pending we show this as its OWN card
// stacked above the (still-usable) composer — same consistent island recipe as
// the "Reconnecting…" card (bg1 + border-border1 + rounded-lg), so the surface
// reads consistently across the app.
//
//   • Copy    — copy the plan markdown
//   • Reject  — deny the ExitPlanMode gate; the agent STAYS in Plan mode
//     (mirrors Claude Code's "No, keep planning") and the wait state ends
//     immediately — the explicit exit that doesn't require typing (user
//     2026-07-04: "how can I exit from this state?")
//   • Approve — allow the ExitPlanMode gate + leave Plan mode (⌘⇧↵)
//   • …and the composer below stays live: typing a follow-up refines the plan
//     (the host denies the gate + rides the follow-up as the next prompt).
//
// A third "hand off to another agent" action is intentionally omitted — Zeros
// retired the agent hand-off flow, so it would be new work; deferred.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ClipboardList, Copy } from "lucide-react";

import { Button } from "@/renderer/shared/ui/primitives/button";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { isInFocusedPane } from "./pane-focus";

interface PlanReviewCardProps {
  /** The plan markdown, for Copy. Null when ExitPlanMode had no body. */
  planText: string | null;
  /** Approve the plan → allow the ExitPlanMode gate + exit Plan mode. */
  onApprove: () => void;
  /** Reject the plan → deny the gate; the agent stays in Plan mode. */
  onReject: () => void;
}

export function PlanReviewCard({
  planText,
  onApprove,
  onReject,
}: PlanReviewCardProps) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Bind the keyboard shortcut once; read the latest onApprove via a ref so the
  // listener effect doesn't re-subscribe on every parent render.
  const onApproveRef = useRef(onApprove);
  onApproveRef.current = onApprove;

  const copy = useCallback(() => {
    if (!planText) return;
    void navigator.clipboard?.writeText(planText);
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  }, [planText]);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  // ⌘/Ctrl+Shift+Enter = Approve (matches the hint on the card). Capture phase
  // so it wins over the composer editor's own Enter handling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
        // Split panes: only the focused pane's card approves — two
        // pending plans must not both approve on one ⌘⇧↵.
        if (!isInFocusedPane(rootRef.current)) return;
        e.preventDefault();
        e.stopPropagation();
        onApproveRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div
      ref={rootRef}
      className="border-border1 bg-bg1 flex items-center gap-2 rounded-lg border px-3.5 py-2.5"
    >
      <ClipboardList
        size={16}
        className="text-fg2 shrink-0"
        aria-hidden="true"
      />
      <span className="text-fg2 min-w-0 flex-1 truncate text-sm">
        Plan ready for review
      </span>
      <Tooltip label="Copy plan">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={copy}
          disabled={!planText}
          className="shrink-0"
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </Tooltip>
      <Tooltip label="Reject plan">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onReject}
          className="shrink-0"
        >
          Reject
        </Button>
      </Tooltip>
      <Tooltip label="Approve plan" shortcut="⌘⇧↵">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={onApprove}
          className="shrink-0"
        >
          Approve
          <kbd className="bg-primary-button-fg/15 text-primary-button-fg text-2xxs ml-1 inline-flex h-4 items-center rounded-sm px-1 font-mono">
            ⌘⇧↵
          </kbd>
        </Button>
      </Tooltip>
    </div>
  );
}
