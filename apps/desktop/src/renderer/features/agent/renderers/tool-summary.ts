// ──────────────────────────────────────────────────────────
// tool-summary — shared icon + count helpers for compact runs
// ──────────────────────────────────────────────────────────
//
// Shared tool-summary formatting; simplified 2026-06-18.
//
// Once a turn settles, its "working" group (tools + reasoning +
// in-between narration + sub-agents) collapses into ONE chip: the
// deduplicated activity icons listed first, then a single plain-text
// "<N> tool calls, <M> messages, <K> agents" roll-up. We never expose
// tool names. The buckets:
//   - tool calls — every non-sub-agent tool (Bash, read, edit, web, MCP)
//   - messages   — every non-tool event: reasoning / thinking and
//     in-between narration (NOT the final answer, which renders bright)
//   - agents     — delegated sub-agents (`subagent` tools), counted
//     separately so "spawned 3 agents" reads at a glance
//
// This module owns the pure data helpers; EventStripe owns the layout.
//
// ──────────────────────────────────────────────────────────

import {
  Bot,
  Brain,
  FileEdit,
  FileText,
  FolderTree,
  Globe,
  Plug,
  Search as SearchIcon,
  Terminal,
} from "lucide-react";
import type { ComponentType } from "react";

import type { AgentMessage, AgentToolMessage } from "../use-agent-session";

/** Three-bucket roll-up of a working group's events, shown to the user
 *  as "<N> tool calls, <M> messages, <K> agents". A "tool call" is any
 *  non-sub-agent tool; an "agent" is a delegated sub-agent (`subagent`
 *  tool); a "message" is any non-tool event (reasoning / thinking /
 *  in-between narration). `toolCalls + agents + messages === length`. */
export interface EventSummaryCounts {
  toolCalls: number;
  messages: number;
  agents: number;
}

/** Pure: bucket a run of events. Sub-agents are split out of the tool
 *  count into their own `agents` bucket; everything that isn't a tool
 *  (thinking, in-between agent text, mode switches) is a "message". */
export function countEventSummary(events: AgentMessage[]): EventSummaryCounts {
  let toolCalls = 0;
  let agents = 0;
  let tools = 0;
  for (const e of events) {
    if (e.kind !== "tool") continue;
    tools++;
    const tk = (e as AgentToolMessage).toolKind;
    if (tk === "subagent" || tk === "task") agents++;
    else toolCalls++;
  }
  return { toolCalls, agents, messages: events.length - tools };
}

/** Pure: "<N> tool calls, <M> messages, <K> agents". A zero bucket is
 *  omitted; all-zero yields "". Singular forms at count 1. Fixed order:
 *  tool calls, then messages, then agents. */
export function formatEventSummary(counts: EventSummaryCounts): string {
  const parts: string[] = [];
  if (counts.toolCalls > 0) {
    parts.push(
      `${counts.toolCalls} ${counts.toolCalls === 1 ? "tool call" : "tool calls"}`,
    );
  }
  if (counts.messages > 0) {
    parts.push(
      `${counts.messages} ${counts.messages === 1 ? "message" : "messages"}`,
    );
  }
  if (counts.agents > 0) {
    parts.push(`${counts.agents} ${counts.agents === 1 ? "agent" : "agents"}`);
  }
  return parts.join(", ");
}

/** Pure: the deduplicated icon strip rendered before the roll-up. One
 *  icon per distinct non-sub-agent tool kind (first-seen order), then a
 *  Bot if any sub-agent ran, then a Brain if the group holds reasoning.
 *  Capped at 5 so a busy burst doesn't sprout a long icon train. */
export function summaryIcons(
  events: AgentMessage[],
): ComponentType<{ className?: string }>[] {
  const out: ComponentType<{ className?: string }>[] = [];
  const seenKinds = new Set<string>();
  let hasAgent = false;
  let hasThinking = false;
  for (const e of events) {
    if (e.kind === "tool") {
      const tk = (e as AgentToolMessage).toolKind;
      if (tk === "subagent" || tk === "task") {
        hasAgent = true;
        continue;
      }
      const key = String(tk ?? "other");
      if (!seenKinds.has(key)) {
        seenKinds.add(key);
        out.push(iconForToolKind(tk));
      }
    } else if (
      e.kind === "text" &&
      (e as { role?: string }).role === "thought"
    ) {
      hasThinking = true;
    }
  }
  if (hasAgent) out.push(Bot);
  if (hasThinking) out.push(Brain);
  return out.slice(0, 5);
}

/** Pick the right Lucide icon for a single tool — used by the
 *  expanded ActionRow's per-tool one-liners and by any other place
 *  that wants a kind-keyed icon. Falls back to FileText. */
export function iconForToolKind(
  kind: AgentToolMessage["toolKind"],
): ComponentType<{ className?: string }> {
  switch (kind) {
    case "edit":
      return FileEdit;
    case "execute":
      return Terminal;
    case "read":
      return FileText;
    case "search":
      return SearchIcon;
    case "list":
      return FolderTree;
    case "fetch":
    case "web_search":
      return Globe;
    case "subagent":
      return Bot;
    case "mcp":
      return Plug;
    default:
      return FileText;
  }
}
