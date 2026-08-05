// ──────────────────────────────────────────────────────────
// renderer registry — dispatch
// ──────────────────────────────────────────────────────────
//
// Centralised lookup that turns an AgentMessage into JSX.
// Existing renderers (text + the unified ToolCard), per-tool-kind cards, and an
// unknown-kind fallback are registered by appending to
// `toolByKind` here — agent-chat.tsx never needs to know.
//
// ──────────────────────────────────────────────────────────

import type {
  AgentMessage,
  AgentTextMessage,
  AgentToolMessage,
} from "../use-agent-session";
import type { RendererRegistry } from "./types";
import { TextMessage } from "./text-message";
import { UnknownMessage } from "./unknown-message";
import { matchSubagent } from "./subagent";
import { CompactionRecordCard } from "./compaction-card";
import { ModelSwitchRecordCard } from "./model-switch-card";
import { BudgetStopRecordCard } from "./budget-stop-card";
import { BackgroundTaskRecord } from "./background-task-record";
import { TaskToolRecord } from "./task-tool-record";
import { QuestionRecordCard } from "./question-card";
import { SubagentCard } from "./tool-subagent";
import { CursorTaskCard } from "./tool-cursor-task";
// 01f: most tool kinds + thought route through the unified
// EventRowRenderer (which wraps EventRow). Two purpose-built cards are
// re-wired below because the flat row can't represent them:
//   - EditCard       — syntax-highlighted diff (the flat row only showed
//                      rawInput JSON / result text, never a diff).
//   - ExitPlanModeCard — DISPLAYS Claude's plan (the flat row couldn't render
//                      markdown). Approve/Copy/follow-up live in the composer's
//                      <PlanReviewCard>, not here. Routed via a guarded matcher
//                      (plan-body only) so Codex's switch_mode escalation is
//                      excluded.
// The other per-tool variants (tool-read/shell/fetch/search/mcp,
// ModeSwitchBanner) stay on the flat row.
import { EventRowRenderer } from "./event-row-renderer";
import { EditCard } from "./tool-edit";
import { ExitPlanModeCard } from "./tool-exit-plan-mode";
import { hasPlanBody } from "./plan-body";

/** The default registry. New renderers register here; this is the single
 *  point of composition for the chat. */
export const defaultRegistry: RendererRegistry = {
  text: {
    user: TextMessage,
    agent: TextMessage,
    // 01f: thought messages route through EventRowRenderer like every
    // other non-text event so Claude's interleaved `tool, thinking,
    // tool` pattern collapses into one stripe instead of fragmenting.
    thought: EventRowRenderer as any,
    system: TextMessage,
  },
  textFallback: TextMessage,
  toolMatchers: [
    // Subagent custom matcher catches agents whose translator hasn't
    // taught itself to emit kind="subagent" yet. Routes to the
    // dedicated SubagentCard (which uses EventRow for its header and
    // nests an EventStripe in its body).
    { match: (t) => matchSubagent(t) !== null, render: SubagentCard },
    // Claude's ExitPlanMode → the plan card, but ONLY when it carries a plan
    // body. `switch_mode` is overloaded: Codex's "Expand permissions"
    // escalation is also kind=switch_mode but has no plan — it must fall
    // through to the generic row (+ the permission card), NOT render as an
    // empty Claude plan card. Guarded here so the by-kind table can't misfire.
    {
      match: (t) => t.toolKind === "switch_mode" && hasPlanBody(t.rawInput),
      render: ExitPlanModeCard,
    },
  ],
  toolByKind: {
    // Every tool kind routes through the unified EventRowRenderer so
    // the visual shape is identical across Claude/Codex/Cursor.
    // Per-kind label + meta extraction lives in
    // event-meta.ts (one place to evolve). The `as any` casts widen
    // EventRowRenderer's `Renderer<AgentMessage>` to the narrower
    // `Renderer<AgentToolMessage>` the registry expects — at runtime
    // the message is always a tool here.
    execute: EventRowRenderer as any,
    // Re-wired (was EventRowRenderer): renders the syntax-highlighted diff.
    edit: EditCard as any,
    read: EventRowRenderer as any,
    search: EventRowRenderer as any,
    fetch: EventRowRenderer as any,
    web_search: EventRowRenderer as any,
    mcp: EventRowRenderer as any,
    // Skill invocations + deferred-tool loading (ToolSearch) — quiet labelled
    // rows via event-meta (Skill /name, "Loading tool: ExitPlanMode") instead
    // of the raw-JSON "other" fallback.
    skill: EventRowRenderer as any,
    tool_search: EventRowRenderer as any,
    task_create: TaskToolRecord,
    task_update: TaskToolRecord,
    // switch_mode is routed by the guarded matcher above (plan-body → the plan
    // card; bodiless Codex escalation → this generic fallback), so it's
    // intentionally NOT in the by-kind table.
    // Question tool → the READ-ONLY transcript record. The INTERACTIVE answer
    // surface is the composer-slot <QuestionCard> (apps/desktop/src/renderer/features/agent/question-
    // card.tsx), driven by the blocking QuestionRequest — not this card.
    question: QuestionRecordCard,
    // Context compaction — two-state row: spinning "Compacting.." →
    // "Context compacted" + Done chip.
    compaction: CompactionRecordCard,
    // The turn continued on a fallback model. Durable, expandable
    // "Model switched · FALLBACK" record, inline where the swap happened.
    model_switch: ModelSwitchRecordCard,
    // The per-turn budget cap ended the turn cleanly. "Turn
    // stopped · BUDGET · CLAUDE" record right above the footer.
    budget_stop: BudgetStopRecordCard,
    // Session-level live background work settles into this ordinary,
    // expandable transcript tool row (no provider-specific terminal chrome).
    background_task: BackgroundTaskRecord,
    // Subagent keeps its own renderer too (threaded body).
    subagent: SubagentCard,
    // Cursor's `task` → the RAW task card (Input/Output JSON + live child tool
    // calls). Distinct from `subagent` so Claude's SubagentCard is unaffected.
    task: CursorTaskCard,
  },
  toolFallback: EventRowRenderer as any,
  byKind: {
    // Adapter-level transient notices (Codex retry attempts, transport
    // warnings) — compact per-event rows, same surface as tool rows.
    error_notice: EventRowRenderer as any,
  },
  unknown: UnknownMessage,
};

/** Look up the renderer for a single message. Pure — no side effects, no
 *  hooks. Callers wrap the result in their own layout / list code. */
export function resolveRenderer(
  message: AgentMessage,
  registry: RendererRegistry = defaultRegistry,
): {
  Component: React.ComponentType<{
    message: AgentMessage;
    ctx: import("./types").RendererContext;
  }>;
} {
  if (message.kind === "text") {
    const Component = (registry.text[(message as AgentTextMessage).role] ??
      registry.textFallback) as React.ComponentType<{
      message: AgentMessage;
      ctx: import("./types").RendererContext;
    }>;
    return { Component };
  }

  if (message.kind === "tool") {
    const tool = message as AgentToolMessage;
    for (const m of registry.toolMatchers) {
      if (m.match(tool)) {
        return {
          Component: m.render as React.ComponentType<{
            message: AgentMessage;
            ctx: import("./types").RendererContext;
          }>,
        };
      }
    }
    if (tool.toolKind) {
      const byKind =
        registry.toolByKind[tool.toolKind as keyof typeof registry.toolByKind];
      if (byKind) {
        return {
          Component: byKind as React.ComponentType<{
            message: AgentMessage;
            ctx: import("./types").RendererContext;
          }>,
        };
      }
    }
    return {
      Component: registry.toolFallback as React.ComponentType<{
        message: AgentMessage;
        ctx: import("./types").RendererContext;
      }>,
    };
  }

  // Non-text/non-tool message kinds dispatch through byKind.
  const byKind = (
    registry.byKind as Record<
      string,
      | React.ComponentType<{
          message: AgentMessage;
          ctx: import("./types").RendererContext;
        }>
      | undefined
    >
  )[message.kind];
  if (byKind) {
    return { Component: byKind };
  }

  // Drift fallback: unknown renderer surfaces them visibly (collapsed JSON)
  // instead of silently dropping — engine/UI drift gets caught at runtime.
  return { Component: registry.unknown };
}
