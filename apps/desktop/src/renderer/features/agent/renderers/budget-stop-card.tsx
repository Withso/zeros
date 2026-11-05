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
import { Badge } from "@/renderer/shared/ui/primitives";
import { DETAIL_BODY_CLS } from "./tool-detail-surface";

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
      <span className="flex shrink-0 items-center gap-1">
        <Badge variant="outline">Budget</Badge>
        {/* Muted scope badge — budget caps are Claude-only for now. */}
        <Badge>Claude</Badge>
      </span>
    );

    const detail = (
      <div className={DETAIL_BODY_CLS}>
        {/* The Claude badge carries the scope; the line says what happened
            and what to do. */}
        <span className="text-fg2">
          The{" "}
          {capUsd != null ? (
            <b className="text-fg1 font-medium">${capUsd.toFixed(2)}</b>
          ) : (
            "configured"
          )}{" "}
          turn budget was reached. Work so far is kept. Continue starts a new
          turn, or raise the cap in Settings → Models.
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
