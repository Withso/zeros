import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import { metaForEvent } from "../renderers/event-meta";
import { EventRowRenderer } from "../renderers/event-row-renderer";
import { toolPresentationReady } from "../renderers/tool-readiness";
import { TooltipProvider } from "../../../shared/ui/primitives";

const args = { command: "xcrun simctl list devices | grep Booted", description: "List booted simulators", mac: "Studio" };
const tool = (rawInput: unknown, title: string, status: AgentToolMessage["status"] = "completed", text?: string, toolKind = "mcp") =>
  ({ kind: "tool", id: "t", toolCallId: "t", nativeToolCallId: "t", title, toolKind, status, rawInput, createdAt: 1, updatedAt: 2,
    content: text ? [{ type: "content", content: { type: "text", text } }] : [] }) as unknown as AgentToolMessage;
const shapes: Array<[string, unknown, string]> = [
  ["codex", { server: "zeros_workspace", tool: "RunLocalCommand", arguments: args }, "zeros_workspace:RunLocalCommand"],
  ["claude", args, "mcp__zeros_workspace__RunLocalCommand"],
  ["cursor", { providerIdentifier: "zeros_workspace", toolName: "RunLocalCommand", args }, "MCP RunLocalCommand"],
];
const row = (message: AgentToolMessage) => renderToStaticMarkup(createElement(TooltipProvider, { children: createElement(EventRowRenderer as never, { message, ctx: { editBaselines: new Map() } }) }));
const words = (html: string) => html.replace(/<[^>]+>/g, "\n").split("\n").map(part => part.trim()).filter(Boolean);

describe("zeros_workspace tools in the transcript", () => {
  it.each(shapes)("names RunLocalCommand by its description, with the command, for %s", (_provider, rawInput, title) => {
    const waiting = metaForEvent(tool(rawInput, title, "in_progress") as unknown as AgentMessage);
    expect(waiting).toMatchObject({ label: "List booted simulators", target: "xcrun simctl list devices | grep Booted", trailing: "Waiting for approval on Studio" });
    expect(metaForEvent(tool(rawInput, title, "completed", "outcome: completed\nmac: Studio\nexit code: 0\n") as unknown as AgentMessage).trailing).toBe("Ran on Studio");
  });

  it("tells each ending in plain words on a neutral row, never a red Error or the raw tool name", () => {
    const ending = (status: AgentToolMessage["status"], text: string) => metaForEvent(tool(args, "mcp__zeros_workspace__RunLocalCommand", status, text) as unknown as AgentMessage);
    expect(ending("completed", "outcome: completed\nmac: Studio\nexit code: 3\n").trailing).toBe("Failed with exit code 3");
    for (const [outcome, said] of [["denied", "Denied"], ["mac_not_connected", "Mac not connected"], ["command_timed_out", "Timed out"], ["approval_timed_out", "Approval timed out"],
      ["cancelled", "Stopped"], ["interrupted", "Interrupted"], ["no_target", "No Mac to run on"], ["disabled", "Local commands are off"]] as const)
      expect(ending("failed", `outcome: ${outcome}\nmac: Studio\n`)).toMatchObject({ trailing: said, tone: "ok" });
    expect(ending("failed", "outcome: failed\nmac: Studio\nerror: cwd_not_found\n").trailing).toBe("Folder not found");
    expect(ending("failed", '{"code":"LOCAL_COMMAND_UNKNOWN","message":"x"}').trailing).toBe("Outcome unknown");
    const html = row(tool(args, "mcp__zeros_workspace__RunLocalCommand", "failed", "outcome: denied\nmac: Studio\n"));
    expect(words(html)).toEqual(expect.arrayContaining(["List booted simulators", "Denied"]));
    expect(html).not.toMatch(/>Error<|mcp__/);
  });

  it("gives NotifyUser, GetTerminalOutput and GetWorkspaceDiff human titles, never mcp__ text, and leaves foreign servers alone", () => {
    const meta = (name: string, input: Record<string, unknown>) => metaForEvent(tool(input, `mcp__zeros_workspace__${name}`) as unknown as AgentMessage);
    expect(meta("NotifyUser", { title: "Ready for review", message: "m", kind: "review" }).label).toBe("Notified you: Ready for review");
    expect(meta("GetTerminalOutput", { source: "run_script" })).toMatchObject({ label: "Read terminal output", target: "run script" });
    expect(meta("GetWorkspaceDiff", { stat: true }).label).toBe("Read changed files");
    expect(meta("GetWorkspaceDiff", { file: "src/a.ts" })).toMatchObject({ label: "Read workspace diff", target: "src/a.ts" });
    expect(meta("CreateReviewComment", {}).label).toBe("Create Review Comment");
    for (const name of ["NotifyUser", "GetTerminalOutput", "GetWorkspaceDiff"]) expect(row(tool({}, `mcp__zeros_workspace__${name}`))).not.toContain("mcp__");
    expect(metaForEvent(tool({ server: "foreign", tool: "RunLocalCommand", arguments: args }, "mcp__zeros_workspace__RunLocalCommand") as unknown as AgentMessage).label).not.toBe("List booted simulators");
  });

  it("hides Claude's ToolSearch row that only loads zeros_workspace tools, and keeps any other", () => {
    const search = (query: string) => tool({ query }, "ToolSearch", "completed", undefined, "tool_search");
    expect(toolPresentationReady(search("select:mcp__zeros_workspace__RunLocalCommand"))).toBe(false);
    expect(toolPresentationReady(search("select:mcp__zeros_workspace__RunLocalCommand,mcp__zeros_workspace__NotifyUser"))).toBe(false);
    expect(toolPresentationReady(search("select:zeros_workspace:GetWorkspaceDiff"))).toBe(false);
    expect(toolPresentationReady(search("select:ExitPlanMode"))).toBe(true);
    expect(toolPresentationReady(search("select:mcp__zeros_workspace__RunLocalCommand,ExitPlanMode"))).toBe(true);
    expect(toolPresentationReady(search("local command"))).toBe(true);
  });

  it("shows RunLocalCommand's reason as a muted line above the row (wire v1.3), and nothing without one", () => {
    const withReason = row(tool({ ...args, reason: "The simulator only runs on the Mac." }, "mcp__zeros_workspace__RunLocalCommand", "in_progress"));
    expect(words(withReason)[0]).toBe("The simulator only runs on the Mac.");
    expect(withReason).toMatch(/<p[^>]*class="text-fg3[^"]*"[^>]*data-local-command-reason=""/);
    expect(row(tool(args, "mcp__zeros_workspace__RunLocalCommand", "in_progress"))).not.toContain("data-local-command-reason");
    // Codex and Cursor carry it in their argument envelopes.
    expect(words(row(tool({ server: "zeros_workspace", tool: "RunLocalCommand", arguments: { ...args, reason: "Needs Xcode." } }, "zeros_workspace:RunLocalCommand")))[0]).toBe("Needs Xcode.");
  });
});
