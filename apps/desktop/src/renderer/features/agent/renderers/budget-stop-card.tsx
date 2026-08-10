// ──────────────────────────────────────────────────────────
// BudgetStopRecordCard — "Turn stopped · BUDGET · CLAUDE"
// ──────────────────────────────────────────────────────────
//
// The durable transcript record of a budget stop: the user's per-turn spend
// cap (Settings → Models → Budget) was reached, so the turn ended cleanly —
// everything completed so far is kept. Emitted by the Claude translator as a
// settled tool_call (kind="budget_stop") right above the footer; it REPLACES
// a footer status pill because the card already names the ending. The footer's
// Continue starts a fresh turn under a fresh cap.
//
// Same EventRow + StatusChip recipe as the "User input" card, plus a muted
// scope pill making the Claude-only scope explicit in the tile.
// ──────────────────────────────────────────────────────────

import { memo } from "react";
import { Wallet } from "lucide-react";

import type { AgentToolMessage } from "../use-agent-session";
import type { Renderer } from "./types";
import { EventRow, type EventMeta } from "./event-row";

function readCapUsd(input: unknown): number | null {
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return typeof obj.capUsd === "number" && obj.capUsd > 0 ? obj.capUsd : null;
}

export const BudgetStopRecordCard: Renderer<AgentToolMessage> = memo(
  function BudgetStopRecordCard({ message, ctx }) {
    const capUsd = readCapUsd(message.rawInput);

    const meta: EventMeta = {
      Icon: Wallet,
      label: "Turn stopped",
      expandable: true,
    };

    const chips = (
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="border-border1 text-fg2 text-xxs flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 font-mono tracking-wide uppercase">
          Budget
        </span>
        {/* Muted scope pill — budget caps are Claude-only for now. */}
        <span className="bg-bg1-hover text-muted-fg text-xxs flex shrink-0 items-center rounded-sm px-1.5 py-0.5 font-mono tracking-wide uppercase">
          Claude
        </span>
      </span>
    );

    const detail = (
      <div className="bg-bg2/60 flex flex-col gap-1.5 rounded-md p-2.5 text-sm leading-relaxed">
        <span className="text-fg2">
          The{" "}
          {capUsd != null ? (
            <b className="text-fg1 font-semibold">${capUsd.toFixed(2)}</b>
          ) : (
            "configured"
          )}{" "}
          per-turn budget was reached, so the turn ended cleanly. Everything
          completed so far is kept.
        </span>
        <span className="text-muted-fg text-[11.5px]">
          Budget caps are Claude Code only for now — Codex &amp; Cursor expose
          no budget hook yet. Continue below starts a fresh turn under a new
          cap, or raise it in Settings → Models.
        </span>
      </div>
    );

    return (
      <EventRow
        message={message}
        ctx={ctx}
        meta={meta}
        detail={detail}
        trailingNode={chips}
        toneOverride="ok"
      />
    );
  },
);
