// ──────────────────────────────────────────────────────────
// CursorTaskCard — Cursor's threaded `task` (subagent)
// ──────────────────────────────────────────────────────────
//
// Uses the shared threaded left rail, collapsed-by-default sub-rows, and
// markdown result. Cursor hands its task a JSON payload, so the first row is
// "Input" and expands to the raw Input JSON card.
//
//   ▸ ⛭ Task  Survey repo structure                     (running ↻)
//        │  ⧉ Input                                  ← collapsed, like Prompt
//        │  📄 Read …   🔍 Grep …   >_ Bash …        ← child tools
//        │  <final report as markdown, no card>      ← like Claude's result
//
// The child tool calls arrive as parentToolId-tagged children (the engine
// discovers and polls the subagent's on-disk transcript — see
// cursor-sdk/translator.ts + subagent-transcript.ts) and render LIVE through
// the SAME EventStripe the rest of the timeline uses.
// ──────────────────────────────────────────────────────────

import { memo, useMemo, useState } from "react";
import {
  Bot,
  Braces,
  ChevronDown,
  ChevronRight,
  Minus,
  Plus,
} from "lucide-react";

import type { AgentToolMessage } from "../use-agent-session";
import type { Renderer } from "./types";
import { EventStripe } from "./event-stripe";
import { statusTone } from "./event-meta";
import { renderMarkdown } from "../markdown";
import { cn } from "@/renderer/shared/ui/cn";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { cursorTaskOpenState } from "./cursor-task-state";

const TONE_ICON_COLOR = {
  ok: "text-fg2",
  fail: "text-red-primary/80",
  run: "text-fg1",
  pending: "text-muted-fg",
} as const;

export const CursorTaskCard: Renderer<AgentToolMessage> = memo(
  function CursorTaskCard({ message, ctx }) {
    const tool = message;
    const isRunning =
      tool.status === "in_progress" || tool.status === "pending";
    const sTone = statusTone(tool.status);

    // One-line summary for the header (the description handed to the subagent).
    const description = readDescription(tool.rawInput);
    // Raw Input JSON — revealed by the "Input" row. The payload is JSON, not
    // markdown, so it keeps
    // the raw card treatment).
    const inputJson = useMemo(() => safeJson(tool.rawInput), [tool.rawInput]);
    // The subagent's report — rendered as markdown with the shared
    // `.zeros-agent-md` styling and no card.
    const outputText = readReportText(tool);
    const outputHtml = useMemo(
      () => (outputText ? renderMarkdown(outputText) : ""),
      [outputText],
    );
    const outputJson = useMemo(
      () => safeJson(tool.rawOutput),
      [tool.rawOutput],
    );

    // The subagent's tool calls (+ narration) stream in as parentToolId-tagged
    // children — rendered live in the body below.
    const children = ctx.subagentChildren.get(tool.toolCallId) ?? [];

    // Empty tasks start collapsed. The first polled child tool call opens the
    // group so activity is visible live; after the user toggles, their explicit
    // choice owns the state and remains sticky while more children stream.
    const [userToggled, setUserToggled] = useState<boolean | null>(null);
    const open = cursorTaskOpenState(userToggled, children.length);
    // The Input row is itself collapsed by default, so an expanded task opens
    // to a tidy list (Input + tool rows) instead of a
    // wall of JSON. Click the Input row to read the raw payload.
    const [inputOpen, setInputOpen] = useState(false);
    const Chev = open ? ChevronDown : ChevronRight;

    return (
      <div className="flex flex-col">
        <button
          type="button"
          className="group/task-row hover:bg-bg2-hover/40 -ml-2 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors"
          onClick={() => setUserToggled(!open)}
          aria-expanded={open}
        >
          <Chev className="text-fg2 size-3 shrink-0" />
          {/* While the task works, the leading icon IS the spinner, so the row
              itself says "working". The tail shimmer + timer stays as
              the turn-level indicator; only it carries the elapsed time. */}
          {isRunning ? (
            <ZerosSpinner
              size={14}
              variant="agent"
              label="Task working"
              className="shrink-0"
            />
          ) : (
            // Same Bot icon as the shared Agent row: one glyph for "subagent"
            // across adapters.
            <Bot className={cn("size-3 shrink-0", TONE_ICON_COLOR[sTone])} />
          )}
          <span className="text-fg1 shrink-0 text-sm">Task</span>
          {description && (
            <span className="text-fg2 min-w-0 truncate text-xs">
              {truncate(description, 80)}
            </span>
          )}
        </button>
        {open && (
          // Threaded body uses the shared rail and rhythm (ml-3.5 rail, no
          // inter-item gap; every sub-row shares the 20px +
          // `py-1` row shape).
          <div className="border-border1 mt-1 mb-2 ml-3.5 flex flex-col border-l pl-3.5">
            {/* Input row — the FIRST thing in every task group: the payload the
                parent handed to this task. Collapsed by default; the leading
                icon swaps to +/- on hover. Click to
                reveal the raw Input JSON in its surface card. */}
            {inputJson && (
              <div className="flex flex-col">
                <button
                  type="button"
                  className="group/input-row hover:bg-bg2-hover/40 -ml-2 flex w-fit max-w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left transition-colors"
                  onClick={() => setInputOpen((v) => !v)}
                  aria-expanded={inputOpen}
                >
                  <span
                    className="text-fg2 relative inline-flex size-3 shrink-0 items-center justify-center [&_svg]:size-3"
                    aria-hidden="true"
                  >
                    <span className="inline-flex group-hover/input-row:hidden">
                      <Braces />
                    </span>
                    <Plus
                      className={cn(
                        "hidden size-3",
                        inputOpen ? "" : "group-hover/input-row:inline",
                      )}
                    />
                    <Minus
                      className={cn(
                        "hidden size-3",
                        inputOpen ? "group-hover/input-row:inline" : "",
                      )}
                    />
                  </span>
                  {/* Name tier (text-sm / 14px), matching the tool rows. */}
                  <span className="text-fg1 text-sm">Input</span>
                </button>
                {inputOpen && (
                  // Left-aligned with the row (px-2), matching the tool-row
                  // detail — no pl-7 indent, no right inset.
                  <div className="px-2 pt-1.5 pb-2">
                    <div className="border-border1 bg-bg2 rounded-lg border px-3.5 py-2.5">
                      <pre className="text-fg1 m-0 max-h-[280px] overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
                        {inputJson}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            )}
            {children.length > 0 && (
              <EventStripe
                events={children}
                ctx={ctx}
                live={isRunning}
                alwaysExpanded
                browserTailClosed={Boolean(outputHtml || outputJson)}
              />
            )}
            {/* Output — the task's final report, rendered as markdown with the
                SAME `.zeros-agent-md` styling as the main agent output (no
                card), matching Claude's subagent result. Falls back to the raw
                result JSON (mono, in a card) when there's no readable report. */}
            {outputHtml ? (
              <div
                className="zeros-agent-md mt-2"
                dangerouslySetInnerHTML={{ __html: outputHtml }}
              />
            ) : (
              outputJson && (
                <div className="border-border1 bg-bg2 mt-2 rounded-lg border px-3.5 py-2.5">
                  <pre className="text-fg1 m-0 max-h-[280px] overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
                    {outputJson}
                  </pre>
                </div>
              )
            )}
          </div>
        )}
      </div>
    );
  },
);

/** The short task summary for the header — `description`, falling back to a
 *  prompt slice. */
function readDescription(input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  const d = input.description ?? input.subagent_type;
  if (typeof d === "string" && d.trim()) return d;
  const p = input.prompt ?? input.task;
  if (typeof p === "string" && p.trim()) return p.slice(0, 120);
  return undefined;
}

/** The subagent's report — its concluding text, surfaced as the card's Output.
 *  Emitted by the translator as a content block on the task card. */
function readReportText(tool: AgentToolMessage): string {
  if (!tool.content) return "";
  const parts: string[] = [];
  for (const block of tool.content) {
    if (block.type === "content") {
      const c = block.content as { type?: string; text?: string };
      if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("").trim();
}

function safeJson(value: unknown): string {
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
