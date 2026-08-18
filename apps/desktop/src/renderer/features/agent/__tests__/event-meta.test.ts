// Coverage for the Bash row's label/target rule (2026-06-18).
//
// The rule: the agent's human description is the bright primary
// label (fg1); the raw command is the muted secondary text (fg2). Without
// a description the label falls back to "Bash". The command preview is
// collapsed to a single line so it truncates cleanly in the row.

import { describe, it, expect } from "vitest";
import {
  isNativeCodexBrowserToolCall,
  metaForEvent,
  nativeCodexBrowserPresentation,
} from "../renderers/event-meta";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";

const exec = (rawInput: Record<string, unknown>): AgentMessage =>
  ({
    kind: "tool",
    toolKind: "execute",
    rawInput,
    title: "Bash",
    content: [],
  }) as unknown as AgentMessage;

describe("metaForEvent — Bash (execute) rows", () => {
  it("uses the agent's description as the bright label when present", () => {
    const meta = metaForEvent(
      exec({ command: "rg -n foo", description: "Find foo callsites" }),
    );
    expect(meta.label).toBe("Find foo callsites");
    expect(meta.target).toBe("rg -n foo");
  });

  it("falls back to 'Bash' when no description is provided", () => {
    const meta = metaForEvent(exec({ command: "ls -la" }));
    expect(meta.label).toBe("Bash");
    expect(meta.target).toBe("ls -la");
  });

  it("collapses whitespace/newlines in the command preview", () => {
    const meta = metaForEvent(exec({ command: "echo a\n  &&  echo   b" }));
    expect(meta.target).toBe("echo a && echo b");
  });
});

describe("metaForEvent — read / search / list rows (Codex commandActions parity)", () => {
  const tool = (toolKind: string, rawInput: Record<string, unknown>): AgentMessage =>
    ({ kind: "tool", toolKind, rawInput, title: "tool", content: [] }) as unknown as AgentMessage;

  it("read kind renders a Read card targeting the file path", () => {
    const meta = metaForEvent(tool("read", { file_path: "README.md" }));
    expect(meta.label).toBe("Read");
    expect(meta.target).toBe("README.md");
  });

  it("renders a Codex imageView as Read image with a filename pill", () => {
    const meta = metaForEvent(
      tool("read", { path: "/tmp/footer-diff-hover.png" }),
    );
    expect(meta.label).toBe("Read image");
    expect(meta.target).toBe("footer-diff-hover.png");
    expect(meta.targetFile).toBe(true);
    expect(meta.expandable).toBe(false);
  });

  it("search kind renders a Grep card targeting the query", () => {
    const meta = metaForEvent(tool("search", { query: "foo" }));
    expect(meta.label).toBe("Grep");
    expect(meta.target).toBe("foo");
  });

  it("list kind renders a List card targeting the directory", () => {
    const meta = metaForEvent(tool("list", { path: "frontend" }));
    expect(meta.label).toBe("List");
    expect(meta.target).toBe("frontend");
  });
});

// Skill + ToolSearch rows (2026-07-04): both are routine Claude harness
// mechanics that used to fall into the raw-JSON "other" fallback and read
// as failures. Skill renders like the slash command the user would type;
// ToolSearch renders as quiet "Loading tool(s)" / "Finding tools" lines.
describe("metaForEvent — skill / tool_search rows", () => {
  const tool = (toolKind: string, rawInput: Record<string, unknown>): AgentMessage =>
    ({ kind: "tool", toolKind, rawInput, title: "tool", content: [] }) as unknown as AgentMessage;

  it("skill kind renders the slash command with args", () => {
    const meta = metaForEvent(tool("skill", { skill: "code-review", args: "high" }));
    expect(meta.label).toBe("Skill");
    expect(meta.target).toBe("/code-review high");
  });

  it("skill kind renders the bare slash command without args", () => {
    const meta = metaForEvent(tool("skill", { skill: "pdf" }));
    expect(meta.target).toBe("/pdf");
  });

  it("tool_search select: query renders 'Loading tool' with the tool name", () => {
    const meta = metaForEvent(tool("tool_search", { query: "select:ExitPlanMode" }));
    expect(meta.label).toBe("Loading tool");
    expect(meta.target).toBe("ExitPlanMode");
  });

  it("tool_search multi-select renders 'Loading tools' with all names", () => {
    const meta = metaForEvent(tool("tool_search", { query: "select:Read,Edit, Grep" }));
    expect(meta.label).toBe("Loading tools");
    expect(meta.target).toBe("Read, Edit, Grep");
  });

  it("tool_search keyword query renders 'Finding tools' with the quoted query", () => {
    const meta = metaForEvent(tool("tool_search", { query: "notebook jupyter" }));
    expect(meta.label).toBe("Finding tools");
    expect(meta.target).toBe('"notebook jupyter"');
  });
});

describe("metaForEvent — native Codex Browser calls", () => {
  it("uses the official node_repl title instead of a generic MCP label", () => {
    const meta = metaForEvent({
      kind: "tool",
      toolKind: "mcp",
      title: "node_repl:js",
      rawInput: {
        server: "node_repl",
        tool: "js",
        arguments: {
          title: "Explore NammaTN page structure",
          code: "await crawlTab.playwright.domSnapshot();",
        },
      },
      content: [],
    } as unknown as AgentMessage);

    expect(meta.label).toBe("Explore NammaTN page structure");
    expect(meta.target).toBeUndefined();
    expect(meta.expandable).toBe(false);
  });

  it("recognizes native Browser metadata in the app-server MCP result shape", () => {
    expect(
      isNativeCodexBrowserToolCall({
        kind: "tool",
        toolKind: "mcp",
        title: "Continue inspection",
        rawInput: {
          server: "node_repl",
          tool: "js",
          arguments: { title: "Continue inspection", code: "await work();" },
        },
        rawOutput: {
          content: [{ type: "text", text: "Done" }],
          structuredContent: null,
          _meta: {
            "codex/browserUse": true,
            browserUse: { url: "https://example.com/native" },
          },
        },
        content: [],
      } as unknown as import("../use-agent-session").AgentToolMessage),
    ).toBe(true);
  });

  it("recognizes the official app-server raw result envelope and its historical URL", () => {
    const tool = {
      kind: "tool",
      toolKind: "mcp",
      title: "node_repl:js",
      status: "completed",
      rawInput: {
        server: "node_repl",
        tool: "js",
        arguments: { title: "Continue inspection", code: "await work();" },
      },
      rawOutput: {
        type: "success",
        content: [{ type: "text", text: "Done" }],
        structuredContent: null,
        raw: {
          content: [{ type: "text", text: "Done" }],
          _meta: {
            browser_use: { url: "https://nammatn.in/welcome" },
            "codex/browserUse": true,
            "codex/toolSurface": { backend: "iab", kind: "browserUse" },
          },
        },
      },
      content: [],
    } as unknown as AgentToolMessage;

    expect(isNativeCodexBrowserToolCall(tool)).toBe(true);
    expect(
      nativeCodexBrowserPresentation(
        tool,
        "https://new.example/dashboard",
      ),
    ).toMatchObject({
      label: "Continue inspection",
      host: "nammatn.in",
      faviconMatchesLivePage: false,
    });
  });

  it("retains historical URLs from the camelCase Browser metadata envelope", () => {
    const tool = {
      kind: "tool",
      toolKind: "mcp",
      title: "node_repl:js",
      status: "completed",
      rawInput: {
        server: "node_repl",
        tool: "js",
        arguments: { title: "Inspect account", code: "await work();" },
      },
      rawOutput: {
        result: {
          raw: {
            _meta: {
              browserUse: { url: "https://account.example/settings" },
              "codex/browserUse": true,
            },
          },
        },
      },
      content: [],
    } as unknown as AgentToolMessage;

    expect(
      nativeCodexBrowserPresentation(tool, "https://new.example/"),
    ).toMatchObject({
      label: "Inspect account",
      host: "account.example",
      faviconMatchesLivePage: false,
    });
  });

  it("keeps provider titles and removes MCP implementation vocabulary", () => {
    const browserTool = {
      kind: "tool",
      toolKind: "mcp",
      title: "node_repl:js",
      status: "in_progress",
      rawInput: {
        server: "node_repl",
        tool: "js",
        arguments: {
          title: "Explore NammaTN page structure",
          code: "await tab.goto('https://nammatn.in/welcome')",
        },
      },
      content: [],
    } as unknown as AgentToolMessage;

    expect(
      nativeCodexBrowserPresentation(
        browserTool,
        "https://nammatn.in/welcome",
      ),
    ).toMatchObject({
      label: "Explore NammaTN page structure",
      target: undefined,
      trailing: undefined,
    });
    expect(
      nativeCodexBrowserPresentation(
        { ...browserTool, status: "completed" },
        "https://nammatn.in/welcome",
      ).label,
    ).toBe("Explore NammaTN page structure");
    expect(
      nativeCodexBrowserPresentation(
        { ...browserTool, status: "failed" },
        "https://nammatn.in/welcome",
      ).label,
    ).toBe("Explore NammaTN page structure");

    expect(
      nativeCodexBrowserPresentation(
        {
          ...browserTool,
          status: "completed",
          rawOutput: {
            _meta: {
              "codex/browserUse": true,
              browser_use: { url: "https://old.example/account" },
            },
          },
        },
        "https://new.example/dashboard",
      ),
    ).toMatchObject({
      label: "Explore NammaTN page structure",
      host: "old.example",
      faviconMatchesLivePage: false,
    });
  });
});
