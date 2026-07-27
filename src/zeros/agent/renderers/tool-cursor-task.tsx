// ──────────────────────────────────────────────────────────
// CursorTaskCard — Cursor's `task` (subagent), threaded like Claude's Agent
// ──────────────────────────────────────────────────────────
//
// 2026-07-05 (per user): match the Claude SubagentCard layout exactly —
// same threaded left rail, same collapsed-by-default sub-rows, same
// markdown result. The only Cursor-specific difference is the first row:
// Claude hands its child a markdown prompt ("Prompt" row), Cursor hands
// its task a JSON payload, so the row is "Input" and expands to the raw
// Input JSON card.
//
//   ▸ ⛭ Task  Survey repo structure                     (running ↻)
//        │  ⧉ Input                                  ← collapsed, like Prompt
//        │  📄 Read …   🔍 Grep …   >_ Bash …        ← child tools
//        │  <final report as markdown, no card>      ← like Claude's result
//
// The child tool calls arrive as parentToolId-tagged children (the engine
// discovers the subagent's on-disk transcript — see cursor-sdk/translator.ts +
// subagent-transcript.ts) and render through the SAME EventStripe the rest of
// the timeline uses. In practice Cursor only delivers them once the subagent
// COMPLETES, so the card renders collapsed by default (see below).
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
import { cn } from "@/zeros/ui/cn";
import { ZerosSpinner } from "@/loaders";

const TONE_ICON_COLOR = {
  ok: "text-fg2",
  fail: "text-red-primary/80",
  run: "text-fg1",
  pending: "text-fg3",
} as const;

export const CursorTaskCard: Renderer<AgentToolMessage> = memo(
  function CursorTaskCard({ message, ctx }) {
    const tool = message;
    const isRunning = tool.status === "in_progress" || tool.status === "pending";
    const sTone = statusTone(tool.status);

    // One-line summary for the header (the description handed to the subagent).
    const description = readDescription(tool.rawInput);
    // Raw Input JSON — revealed by the "Input" row (Cursor's analog of
    // Claude's "Prompt" row; the payload is JSON, not markdown, so it keeps
    // the raw card treatment).
    const inputJson = useMemo(() => safeJson(tool.rawInput), [tool.rawInput]);
    // The subagent's report — rendered as markdown with the SAME
    // `.zeros-agent-md` styling as Claude's subagent result (no card).
    const outputText = readReportText(tool);
    const outputHtml = useMemo(
      () => (outputText ? renderMarkdown(outputText) : ""),
      [outputText],
    );
    const outputJson = useMemo(() => safeJson(tool.rawOutput), [tool.rawOutput]);

    // The subagent's tool calls (+ narration) stream in as parentToolId-tagged
    // children — rendered live in the body below.
    const children = ctx.subagentChildren.get(tool.toolCallId) ?? [];

    // COLLAPSED by default — running or settled (2026-07-04, per user). Cursor
    // only surfaces the child's tool calls after the subagent completes, so
    // auto-expanding mid-run showed just the Input block. The header spinner
    // conveys "working"; an explicit toggle opens the body and sticks.
    const [userToggled, setUserToggled] = useState<boolean | null>(null);
    const open = userToggled ?? false;
    // The Input row is itself collapsed by default — like Claude's Prompt row —
    // so an expanded task opens to a tidy list (Input + tool rows) instead of a
    // wall of JSON. Click the Input row to read the raw payload.
    const [inputOpen, setInputOpen] = useState(false);
    const Chev = open ? ChevronDown : ChevronRight;

    return (
      <div className="flex flex-col">
        <button
          type="button"
          className="group/task-row -ml-2 flex w-fit min-w-0 max-w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-bg2-hover/40"
          onClick={() => setUserToggled(!open)}
          aria-expanded={open}
        >
          <Chev className="size-3 shrink-0 text-fg2" />
          {/* While the task works, the leading icon IS the spinner — the row
              itself must say "working" (2026-07-04, per user; see the same
              block in tool-subagent.tsx). The tail shimmer + timer stays as
              the turn-level indicator; only it carries the elapsed time. */}
          {isRunning ? (
            <ZerosSpinner
              size={14}
              variant="agent"
              label="Task working"
              className="shrink-0"
            />
          ) : (
            // Same Bot icon as the Claude/Codex Agent row (tool-subagent.tsx)
            // — one glyph for "subagent" across all three agents (2026-07-05,
            // per user).
            <Bot className={cn("size-3 shrink-0", TONE_ICON_COLOR[sTone])} />
          )}
          <span className="shrink-0 text-sm text-fg1">Task</span>
          {description && (
            <span className="min-w-0 truncate text-xs text-fg2">
              {truncate(description, 80)}
            </span>
          )}
        </button>
        {open && (
          // Threaded body — same rail + rhythm as the Claude SubagentCard
          // (ml-3.5 rail, no inter-item gap; every sub-row shares the 20px +
          // `py-1` row shape).
          <div className="ml-3.5 mt-1 mb-2 flex flex-col border-l border-border1 pl-3.5">
            {/* Input row — the FIRST thing in every task group: the payload the
                parent handed to this task. Collapsed by default, like Claude's
                Prompt row — the leading icon swaps to +/- on hover; click to
                reveal the raw Input JSON in its surface card. */}
            {inputJson && (
              <div className="flex flex-col">
                <button
                  type="button"
                  className="group/input-row -ml-2 flex w-fit max-w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-bg2-hover/40"
                  onClick={() => setInputOpen((v) => !v)}
                  aria-expanded={inputOpen}
                >
                  <span
                    className="relative inline-flex size-3 shrink-0 items-center justify-center text-fg2 [&_svg]:size-3"
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
                  <span className="text-sm text-fg1">Input</span>
                </button>
                {inputOpen && (
                  // Left-aligned with the row (px-2), matching the tool-row
                  // detail — no pl-7 indent, no right inset.
                  <div className="px-2 pt-1.5 pb-2">
                    <div className="rounded-lg border border-border1 bg-bg2 px-3.5 py-2.5">
                      <pre className="m-0 max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-fg1">
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
                <div className="mt-2 rounded-lg border border-border1 bg-bg2 px-3.5 py-2.5">
                  <pre className="m-0 max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-fg1">
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
