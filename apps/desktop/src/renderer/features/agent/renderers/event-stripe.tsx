// ──────────────────────────────────────────────────────────
// EventStripe — the "working" group (reasoning + tools)
// ──────────────────────────────────────────────────────────
//
// A turn's working content — tool calls, thinking, in-between
// narration, sub-agents — renders as ONE group:
//
//   • While the turn is LIVE (the agent is working): fully
//     EXPANDED with NO header chip, every row dimmed, each
//     individual item collapsed to one line. The user watches
//     the agent reason + act in real time.
//
//   • Once the turn settles (live=false): the whole group
//     COLLAPSES into one chip —
//
//       ▸ 📄 >_ 🔍 🤖  6 tool calls, 2 messages, 3 agents
//
//     — and the agent's final answer (rendered by the parent,
//     bright) sits below it. Click the chip to re-expand the
//     dimmed history.
//
// Borderless. No card. No shadow. Just rows.
// ──────────────────────────────────────────────────────────

import { memo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import type { RendererContext } from "./types";
import {
  countEventSummary,
  formatEventSummary,
  summaryIcons,
} from "./tool-summary";
import { MessageView } from "./message-view";

interface EventStripeProps {
  events: AgentMessage[];
  ctx: RendererContext;
  /** True while the turn is actively streaming — the agent is "working."
   *  A live group renders fully expanded, no header chip, rows dimmed. Once
   *  the turn finishes (live=false) it collapses into one summary chip. */
  live: boolean;
  /** Sub-agent bodies pass this: always render the (dimmed) children, never
   *  the collapse chip — the SubagentCard row is the collapse boundary. */
  alwaysExpanded?: boolean;
}

// Brightness split inside the feed (styles/global/runtime-content.css,
// `.zeros-working-feed`):
// tool-row NAMES and OUTPUT markdown (the top-level answer, and a sub-agent's
// result/"Output" — a bare `.zeros-agent-md`) read at full `fg1`; only the
// in-between NARRATION (TextMessage, carrying `[data-role]`) is muted to `fg2`,
// uniformly down to bold/headings/links. So output reads like our own output
// markdown at every depth. The working-vs-answer
// split is also structural: the feed collapses to one summary chip on settle.

export const EventStripe = memo(function EventStripe({
  events,
  ctx,
  live,
  alwaysExpanded = false,
}: EventStripeProps) {
  const [userExpanded, setUserExpanded] = useState(false);

  // Force the group open while it holds a pending permission, so the gated
  // row (e.g. Claude's "Plan ready for review") is never hidden inside a
  // collapsed summary chip while the user's decision pends: the plan must stay
  // visible until approved or rejected.
  // ⚠️ The permission request references the VENDOR's tool-use id, which is
  // the transcript row's nativeToolCallId (the Claude translator mints its
  // own uuid for toolCallId) — match BOTH, same as the question record.
  const pendingPermId = ctx.pendingPermission?.request.toolCall.toolCallId;
  const hasPendingPermission =
    !!pendingPermId &&
    events.some((e) => {
      if (e.kind !== "tool") return false;
      const t = e as AgentToolMessage;
      return (
        t.toolCallId === pendingPermId || t.nativeToolCallId === pendingPermId
      );
    });

  // Same guard for a pending blocking QUESTION: its "Awaiting response"
  // record row must stay visible while the user's answer pends, not fold
  // into a collapsed chip (the interactive card lives in the composer slot,
  // but the transcript record is the only in-feed cue it's waiting).
  const hasPendingQuestion =
    ctx.pendingQuestionToolCallIds.size > 0 &&
    events.some((e) => {
      if (e.kind !== "tool") return false;
      const t = e as AgentToolMessage;
      return (
        ctx.pendingQuestionToolCallIds.has(t.toolCallId) ||
        (!!t.nativeToolCallId &&
          ctx.pendingQuestionToolCallIds.has(t.nativeToolCallId))
      );
    });

  if (events.length === 0) return null;

  // The collapse chip is the only place a header appears. It shows once the
  // turn is done (not live), this isn't a sub-agent body, and nothing is
  // forcing the rows open for a pending permission/question. A LONE event is
  // NOT special-cased: even a single tool call folds into the same summary
  // chip ("1 tool call") once the turn settles, so every settled turn's
  // working feed reads uniformly. Otherwise a one-edit turn renders a bare Edit
  // row while multi-event turns get the group chip.
  const showHeader =
    !live && !alwaysExpanded && !hasPendingPermission && !hasPendingQuestion;
  const expanded = !showHeader || userExpanded;
  const Chev = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="flex flex-col">
      {showHeader && (
        <button
          type="button"
          // Content-width chip (`w-fit`, lane-capped via `max-w-full`) so the
          // hover tint wraps the summary + icons, not the empty lane to the
          // right; hover should fit the content.
          className="group/event-stripe hover:bg-bg2-hover/40 -ml-1 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors"
          onClick={() => setUserExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <Chev className="text-fg2 size-3 shrink-0" />
          {/* The roll-up FIRST: "<N> tool calls, <M> messages, <K> agents".
              Natural width (truncates if the row is narrow) so the icons sit
              directly after it rather than at the far right edge. */}
          <span className="text-fg2 min-w-0 truncate text-sm">
            {formatEventSummary(countEventSummary(events))}
          </span>
          {/* Activity icons at the END, after the text: deduped tool kinds +
              Bot (any sub-agent) + Brain (any
              reasoning), capped at 5, visible. */}
          <StripeIcons events={events} />
        </button>
      )}
      {expanded && (
        // `zeros-working-feed` tags the group so runtime-content.css mutes it to fg2 and
        // flattens narration padding. Each row owns its OWN 4px top/bottom
        // padding (`py-1` on the hover target itself, not an outer wrapper).
        //
        // A TOP-LEVEL feed adds a 4px gap BETWEEN entries (`gap-y-1`) for
        // breathing room; a NESTED agent / task body (`alwaysExpanded`) keeps
        // its many tool calls tight, with no gap. Top-level entries are wrapped
        // in a plain div so the gap
        // lands between entries and a row's inline permission cluster keeps
        // hugging its card; nested rows render directly, unchanged.
        <div
          className={cn(
            "zeros-working-feed flex flex-col",
            !alwaysExpanded && "gap-y-1",
            showHeader && "py-1",
          )}
        >
          {events.map((event) =>
            alwaysExpanded ? (
              <MessageView key={event.id} message={event} ctx={ctx} />
            ) : (
              <div key={event.id}>
                <MessageView message={event} ctx={ctx} />
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
});

function StripeIcons({ events }: { events: AgentMessage[] }) {
  const icons = summaryIcons(events);
  if (icons.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-1" aria-hidden="true">
      {icons.map((Icon, i) => (
        <span
          key={i}
          className="text-fg2 inline-flex size-3 items-center justify-center"
        >
          <Icon className="size-3" />
        </span>
      ))}
    </div>
  );
}
