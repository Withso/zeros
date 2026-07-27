// ──────────────────────────────────────────────────────────
// ExitPlanModeCard — the plan, rendered in the transcript
// ──────────────────────────────────────────────────────────
//
// Claude's `ExitPlanMode` tool is the agent's signal "I've drafted a plan;
// review it." It's a permission-gated tool, so a permission request arrives
// alongside the tool_call.
//
// Plan review is NOT a permission card. A permission card is a blocking Yes/No
// that REPLACES the composer; plan review keeps the composer live so the user
// can Approve, Copy, or type a follow-up to refine the plan (see
// <PlanReviewCard>, a standalone card above the composer while a plan pends).
//
// So this card's only job is to DISPLAY the plan markdown + a status header.
// The approve / copy / follow-up actions live in the composer bar, not here.
//
// Rendered ON TOP OF EventRow (2026-07-04 consistency pass, same as
// QuestionRecordCard): the 12px icon cell, the 14px fg1 label tier and the
// left-edge alignment must match every other tool row — the plan header had
// its own ToolHeader chrome (16px icon, font-medium, indented 8px) and read
// as a different surface (user screenshots 2026-07-04).
//
// ⚠️ Routing: the registry only sends a `switch_mode` tool to THIS card when it
// carries a `plan` body (Claude's ExitPlanMode). Codex's "Expand permissions"
// escalation is ALSO kind=switch_mode but has no plan — it falls through to the
// generic row + the permission card. `hasPlanBody` is the guard (exported).
// ──────────────────────────────────────────────────────────

import { memo, useMemo } from "react";
import { CircleX, ClipboardList } from "lucide-react";

import { ZerosSpinner } from "@/loaders";

import type { Renderer } from "./types";
import type { AgentToolMessage } from "../use-agent-session";
import { renderMarkdown } from "../markdown";
import { readPlan } from "./plan-body";
import { EventRow, type EventMeta } from "./event-row";

type ExitPlanStatus = "pending" | "approved" | "rejected";

export const ExitPlanModeCard: Renderer<AgentToolMessage> = memo(
  function ExitPlanModeCard({ message, ctx }) {
    const tool = message;
    const planText = readPlan(tool.rawInput);
    const planHtml = useMemo(
      () => (planText ? renderMarkdown(planText) : null),
      [planText],
    );

    // Match a permission request to this tool → drives the "ready for review"
    // vs "approved / rejected" header. The ACTIONS live in <PlanReviewCard>.
    // The request holds the VENDOR's tool-use id = this row's nativeToolCallId
    // (Claude mints its own uuid for toolCallId) — match both, same as the
    // question record + EventStripe.
    const permId = ctx.pendingPermission?.request.toolCall.toolCallId;
    const pending =
      !!permId &&
      (permId === tool.toolCallId || permId === tool.nativeToolCallId);

    const status: ExitPlanStatus = pending
      ? "pending"
      : tool.status === "completed"
        ? "approved"
        : tool.status === "failed"
          ? "rejected"
          : "pending";

    const meta: EventMeta = {
      Icon: ClipboardList,
      label:
        status === "pending"
          ? "Plan ready for review"
          : status === "approved"
            ? "Plan approved"
            : "Plan rejected",
      expandable: true,
    };

    // Trailing status: awaiting-review spinner / rejected ✕. No green ✓ on an
    // approved plan (per design) — the "Plan approved" label already conveys it.
    const trailing =
      status === "pending" ? (
        <ZerosSpinner
          size={12}
          label="Awaiting review"
          className="shrink-0"
        />
      ) : status === "rejected" ? (
        <CircleX
          aria-label="Rejected"
          className="size-3 shrink-0 text-red-primary"
        />
      ) : undefined;

    // The plan body renders FLAT — no bg3/40 detail box (user 2026-07-04:
    // "no bg, only for this tool call's expand view"). Unlike shell output,
    // the plan is the turn's focal document; it reads as answer markdown.
    const detail = planHtml ? (
      <div
        className="zeros-agent-md text-fg1 text-sm"
        dangerouslySetInnerHTML={{ __html: planHtml }}
      />
    ) : (
      <div className="text-fg2 text-xs">
        (the agent invoked ExitPlanMode without a plan body)
      </div>
    );

    return (
      <EventRow
        message={message}
        ctx={ctx}
        meta={meta}
        detail={detail}
        trailingNode={trailing}
        // Rejection is DELIVERED via a deny tool_result (a transport detail,
        // same as the question record) — never tint the plan row red.
        toneOverride="ok"
        // The plan is the turn's focal document — start expanded.
        defaultOpen
      />
    );
  },
);
