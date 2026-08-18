import { describe, expect, it } from "vitest";

import { groupBrowserToolActivity } from "../../browser/browser-tool-activity";
import type {
  AgentMessage,
  AgentToolMessage,
} from "../use-agent-session";

function nativeBrowserTool(id: string): AgentToolMessage {
  return {
    id,
    kind: "tool",
    toolCallId: id,
    toolKind: "mcp",
    title: "node_repl:js",
    status: "completed",
    rawInput: {
      server: "node_repl",
      tool: "js",
      arguments: {
        title: "Explore NammaTN",
        code: "await tab.goto('https://nammatn.in/welcome')",
      },
    },
    content: [],
  } as unknown as AgentToolMessage;
}

function ordinaryTool(id: string): AgentToolMessage {
  return {
    id,
    kind: "tool",
    toolCallId: id,
    toolKind: "read",
    title: "Read",
    status: "completed",
    rawInput: { path: "README.md" },
    content: [],
  } as unknown as AgentToolMessage;
}

describe("settled Browser activity grouping", () => {
  it("keeps native Codex Browser calls inside the overall settled working group", () => {
    const browser = nativeBrowserTool("browser-1");
    const read = ordinaryTool("read-1");

    expect(
      groupBrowserToolActivity([read, browser]).map((item) => item.kind),
    ).toEqual(["event", "browser-activity"]);
  });

  it("does not pin an unrelated node_repl call without Browser code or metadata", () => {
    const repl = {
      ...nativeBrowserTool("repl-1"),
      rawInput: {
        server: "node_repl",
        tool: "js",
        arguments: { title: "Calculate", code: "nodeRepl.write(6 * 7)" },
      },
    } as unknown as AgentMessage;

    expect(groupBrowserToolActivity([repl])).toEqual([
      { kind: "event", id: "repl-1", event: repl },
    ]);
  });
});
