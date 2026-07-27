// Pure-function coverage for the working-group roll-up (2026-06-18).
//
// Once a turn settles, its working group collapses to one chip:
// "<N> tool calls, <M> messages, <K> agents". Rules under test:
//   - tool calls = non-sub-agent tools (Bash, read, edit, web, MCP)
//   - agents     = sub-agent tools, counted in their own bucket
//   - messages   = every non-tool event (thinking, in-between narration)
//   - the icon strip dedupes by activity kind, capped at 5

import { describe, it, expect } from "vitest";
import {
  countEventSummary,
  formatEventSummary,
  summaryIcons,
} from "../renderers/tool-summary";
import type { AgentMessage } from "../use-agent-session";

const tool = (toolKind: string): AgentMessage =>
  ({ kind: "tool", toolKind }) as unknown as AgentMessage;
const thought = (): AgentMessage =>
  ({ kind: "text", role: "thought" }) as unknown as AgentMessage;
const agentText = (): AgentMessage =>
  ({ kind: "text", role: "agent" }) as unknown as AgentMessage;
const errorNotice = (): AgentMessage =>
  ({ kind: "error_notice" }) as unknown as AgentMessage;

describe("countEventSummary", () => {
  it("splits sub-agents out of the tool-call count into their own bucket", () => {
    const events = [
      tool("execute"),
      tool("read"),
      tool("edit"),
      tool("subagent"),
      tool("subagent"),
    ];
    expect(countEventSummary(events)).toEqual({
      toolCalls: 3,
      messages: 0,
      agents: 2,
    });
  });

  it("counts reasoning, narration, and error notices as messages", () => {
    const events = [tool("read"), thought(), agentText(), errorNotice()];
    expect(countEventSummary(events)).toEqual({
      toolCalls: 1,
      messages: 3,
      agents: 0,
    });
  });

  it("toolCalls + messages + agents always equals the event count", () => {
    const events = [
      tool("read"),
      thought(),
      tool("subagent"),
      agentText(),
      tool("execute"),
    ];
    const { toolCalls, messages, agents } = countEventSummary(events);
    expect(toolCalls + messages + agents).toBe(events.length);
  });

  it("handles an empty run", () => {
    expect(countEventSummary([])).toEqual({
      toolCalls: 0,
      messages: 0,
      agents: 0,
    });
  });
});

describe("formatEventSummary", () => {
  it("joins all three buckets in a fixed order with pluralization", () => {
    expect(
      formatEventSummary({ toolCalls: 10, messages: 13, agents: 3 }),
    ).toBe("10 tool calls, 13 messages, 3 agents");
  });

  it("uses singular forms at a count of one", () => {
    expect(formatEventSummary({ toolCalls: 1, messages: 1, agents: 1 })).toBe(
      "1 tool call, 1 message, 1 agent",
    );
  });

  it("omits zero buckets", () => {
    expect(formatEventSummary({ toolCalls: 4, messages: 0, agents: 0 })).toBe(
      "4 tool calls",
    );
    expect(formatEventSummary({ toolCalls: 0, messages: 0, agents: 2 })).toBe(
      "2 agents",
    );
  });

  it("returns an empty string when every bucket is zero", () => {
    expect(formatEventSummary({ toolCalls: 0, messages: 0, agents: 0 })).toBe(
      "",
    );
  });
});

describe("summaryIcons", () => {
  it("dedupes by tool kind and appends Bot + Brain when present", () => {
    const events = [
      tool("read"),
      tool("read"),
      tool("execute"),
      tool("subagent"),
      thought(),
    ];
    // read (FileText), execute (Terminal), Bot (sub-agent), Brain (thinking).
    expect(summaryIcons(events)).toHaveLength(4);
  });

  it("caps the strip at 5 icons", () => {
    const events = [
      tool("read"),
      tool("edit"),
      tool("execute"),
      tool("search"),
      tool("web_search"),
      tool("mcp"),
      tool("subagent"),
      thought(),
    ];
    expect(summaryIcons(events).length).toBeLessThanOrEqual(5);
  });

  it("returns no icons for a messages-only run", () => {
    expect(summaryIcons([agentText(), agentText()])).toEqual([]);
  });
});
