// ──────────────────────────────────────────────────────────
// SubagentCard — parent agent delegating to a child
// ──────────────────────────────────────────────────────────
//
// Built on EventRow +
// EventStripe so the threaded body uses the SAME row primitive
// as the rest of the timeline (no special chrome).
//
//   🤖  Agent  Audit chat rendering pipeline             2m 28s  done  ✓
//        │
//        │  📄 Read package.json                          200 lines read ✓
//        │  >_ Bash pnpm install                                exit 0   ✓
//        │  🧠 Thinking                                                  ⌄
//        │  [Zeros-logo shimmer]  4.5s                                    ← while running
//
// Children are sourced first from `ctx.subagentChildren` (Claude's
// parentToolId path). For adapters that don't emit parentToolId, we
// heuristically fall back
// to any sibling messages whose createdAt falls between this
// subagent's createdAt and updatedAt.
// ──────────────────────────────────────────────────────────

import { memo, useMemo, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Minus,
  Plus,
} from "lucide-react";

import type { AgentToolMessage } from "../use-agent-session";
import type { Renderer } from "./types";
import { matchSubagent } from "./subagent";
import { EventStripe } from "./event-stripe";
import { statusTone } from "./event-meta";
import { renderMarkdown } from "../markdown";
import { cn } from "@/renderer/shared/ui/cn";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";

const TONE_ICON_COLOR = {
  ok: "text-fg2",
  fail: "text-red-primary/80",
  run: "text-fg1",
  pending: "text-fg3",
} as const;

export const SubagentCard: Renderer<AgentToolMessage> = memo(
  function SubagentCard({ message, ctx }) {
    const tool = message;
    const info = matchSubagent(tool) ?? {
      subagentType: undefined,
      description: undefined,
    };
    // Header = the short task summary. The FULL prompt handed to the
    // sub-agent renders separately in the "Prompt" block below.
    const headerText = info.description ?? info.subagentType ?? tool.title;
    const promptText = readPromptText(tool.rawInput);
    const resultText = readResultText(tool);

    // Markdown for the prompt block + the final answer. Both render with the
    // SAME `.zeros-agent-md` styling as the main agent output, memoized so a
    // streaming sub-agent doesn't re-parse each tick.
    const promptHtml = useMemo(
      () => (promptText ? renderMarkdown(promptText) : ""),
      [promptText],
    );
    const resultHtml = useMemo(
      () => (resultText ? renderMarkdown(resultText) : ""),
      [resultText],
    );

    // Children: prefer parentToolId-tagged children; fall back to any
    // sibling messages whose timestamps overlap the subagent's run.
    const childrenFromCtx = ctx.subagentChildren.get(tool.toolCallId) ?? [];
    // This scope cannot see siblings, so it relies solely on the context map.
    const children = childrenFromCtx;

    const sTone = statusTone(tool.status);
    const isRunning =
      tool.status === "in_progress" || tool.status === "pending";

    // Sub-agents render COLLAPSED by default, running or settled. Cursor can't
    // stream a task's child tools mid-run (they only
    // arrive once the subagent completes), so its auto-expanded card showed a
    // lone Input block; the shared default keeps adapter behavior consistent. The header
    // spinner alone conveys "working"; an explicit toggle opens the body (and
    // sticks) — on Claude that's the live child stream, on Cursor the tools
    // fill in at completion.
    const [userToggled, setUserToggled] = useState<boolean | null>(null);
    const open = userToggled ?? false;
    // The Prompt block (the task handed to this sub-agent) is itself collapsed
    // by default, like any other tool row, so an
    // expanded agent group opens to a tidy list (Prompt + tool rows) instead of
    // a wall of prompt text. Click the Prompt row to read the full prompt.
    const [promptOpen, setPromptOpen] = useState(false);
    const Chev = open ? ChevronDown : ChevronRight;

    return (
      <div className="flex flex-col">
        <button
          type="button"
          // Content-width row (`w-fit`, capped at the lane via `max-w-full`)
          // so the hover tint hugs the content instead of the full lane.
          className="group/subagent-row hover:bg-bg2-hover/40 -ml-2 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors"
          onClick={() => setUserToggled(!open)}
          aria-expanded={open}
        >
          <Chev className="text-fg2 size-3 shrink-0" />
          {/* While the subagent works, the leading icon IS the spinner — the
              row itself must say "working", because with the
              body expanded the row can sit far above the turn's tail shimmer,
              and collapsed the static icon read as inert. The TAIL shimmer +
              timer (turn-event-list.tsx) still runs as the turn-level
              indicator — the row spinner carries no timer, so the elapsed
              time renders exactly once. Settled → static Bot. */}
          {isRunning ? (
            <ZerosSpinner
              size={14}
              variant="agent"
              label="Subagent working"
              className="shrink-0"
            />
          ) : (
            <Bot className={cn("size-3 shrink-0", TONE_ICON_COLOR[sTone])} />
          )}
          {/* "Agent" = the name tier (text-sm / 14px); the task summary is
              content (text-xs / 12px) — same name-14 / content-12 split as the
              tool rows (event-row.tsx). */}
          <span className="text-fg1 shrink-0 text-sm">Agent</span>
          <span className="text-fg2 min-w-0 truncate text-xs">
            {truncate(headerText, 80)}
          </span>
          {/* No elapsed-time counter on the Agent row itself; the tail
              shimmer's timer carries the elapsed time. */}
        </button>
        {open && (
          // No inter-item gap (was gap-2, which made the Prompt sit further
          // from the first tool than tools sat from each other): the Prompt
          // collapsible and the nested tool rows all share the same 20px +
          // `py-1` row shape, so everything under the agent group shares one
          // rhythm.
          <div className="border-border1 mt-1 mb-2 ml-3.5 flex flex-col border-l pl-3.5">
            {/* Prompt block — the FIRST thing in every agent group: the task
                the parent handed to this sub-agent. Collapsed by default, like
                any other tool row — the leading icon swaps to +/- on hover;
                click to reveal the full prompt as markdown (same styling as
                agent output) in its surface card. */}
            {promptHtml && (
              <div className="flex flex-col">
                <button
                  type="button"
                  className="group/prompt-row hover:bg-bg2-hover/40 -ml-2 flex w-fit max-w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left transition-colors"
                  onClick={() => setPromptOpen((v) => !v)}
                  aria-expanded={promptOpen}
                >
                  <span
                    className="text-fg2 relative inline-flex size-3 shrink-0 items-center justify-center [&_svg]:size-3"
                    aria-hidden="true"
                  >
                    <span className="inline-flex group-hover/prompt-row:hidden">
                      <MessageSquare />
                    </span>
                    <Plus
                      className={cn(
                        "hidden size-3",
                        promptOpen ? "" : "group-hover/prompt-row:inline",
                      )}
                    />
                    <Minus
                      className={cn(
                        "hidden size-3",
                        promptOpen ? "group-hover/prompt-row:inline" : "",
                      )}
                    />
                  </span>
                  {/* Name tier (text-sm / 14px), matching the tool rows. */}
                  <span className="text-fg1 text-sm">Prompt</span>
                </button>
                {promptOpen && (
                  // Left-aligned with the row (px-2), matching the tool-row
                  // detail — no pl-7 indent, no right inset.
                  <div className="px-2 pt-1.5 pb-2">
                    <div className="border-border1 bg-bg2 rounded-lg border px-3.5 py-2.5">
                      <div
                        className="zeros-agent-md"
                        dangerouslySetInnerHTML={{ __html: promptHtml }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
            {children.length > 0 && (
              // The SubagentCard row IS the collapse boundary, so the body
              // always renders its children directly — no nested summary chip.
              // When there are no children (the subagent is still running, or
              // an adapter that only surfaces them on completion) the header
              // shimmer alone conveys "working" — no placeholder line and no
              // nested tail shimmer.
              <EventStripe
                events={children}
                ctx={ctx}
                live={isRunning}
                alwaysExpanded
              />
            )}
            {/* Result — the sub-agent's final answer, rendered as markdown with
                the SAME `.zeros-agent-md` styling as the main agent output and
                no card. */}
            {resultHtml && (
              // The sub-agent's final answer — separated from the flush tool
              // list with a small top margin (it's the result, not a peer
              // working item), now that the body itself has no inter-item gap.
              <div
                className="zeros-agent-md mt-2"
                dangerouslySetInnerHTML={{ __html: resultHtml }}
              />
            )}
          </div>
        )}
      </div>
    );
  },
);

/** The full prompt handed to the sub-agent (shown in the Prompt block). We
 *  read `prompt`/`task` only — `description` is the short header summary, not
 *  the prompt, so excluding it avoids duplicating the header in the card. */
function readPromptText(input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  const p = input.prompt ?? input.task;
  if (typeof p === "string" && p.trim().length > 0) return p;
  return undefined;
}

function readResultText(tool: AgentToolMessage): string {
  if (!tool.content) return "";
  const parts: string[] = [];
  for (const block of tool.content) {
    if (block.type === "content") {
      const c = block.content as { type?: string; text?: string };
      if (c?.type === "text" && typeof c.text === "string") {
        parts.push(c.text);
      }
    }
  }
  return parts.join("");
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
