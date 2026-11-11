import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import { metaForEvent } from "../renderers/event-meta";
import { EventRowRenderer } from "../renderers/event-row-renderer";
import { toolPresentationReady } from "../renderers/tool-readiness";
import { workspaceToolMeta } from "../renderers/workspace-tool-presentation";
import { summaryIcons } from "../renderers/tool-summary";
import { Laptop, Plug, Terminal } from "lucide-react";
import { acceptLocalCommandApprovalsForTests, type LocalCommandApprovalView } from "../../../platform/local-commands";
import { cloudScopedId } from "../../../platform/bridge/cloud-workspace-key";
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
    // Running with its arguments known: the description and the command, and no approval claim.
    const running = metaForEvent(tool(rawInput, title, "in_progress") as unknown as AgentMessage);
    expect(running).toMatchObject({ label: "List booted simulators", target: "xcrun simctl list devices | grep Booted" });
    expect(running.trailing).toBeUndefined();
    // Waiting only when main really holds this chat's approval.
    expect(workspaceToolMeta(tool(rawInput, title, "in_progress"), { waitingOn: "Studio" })?.trailing).toBe("Waiting for approval on Studio");
    // A successful ending adds no words: reason, icons, title and command.
    expect(metaForEvent(tool(rawInput, title, "completed", "outcome: completed\nmac: Studio\nexit code: 0\n") as unknown as AgentMessage).trailing).toBeUndefined();
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

  it("shows a laptop and then a terminal prompt as two glyphs, on the row and in a group's summary, never the MCP plug", () => {
    for (const [, rawInput, title] of shapes) {
      const meta = metaForEvent(tool(rawInput, title, "completed", "outcome: completed\nmac: Studio\nexit code: 0\n") as unknown as AgentMessage);
      expect([meta.Icon, meta.SecondIcon]).toEqual([Laptop, Terminal]);
      const html = row(tool(rawInput, title, "completed", "outcome: completed\nmac: Studio\nexit code: 0\n"));
      expect(html.indexOf("lucide-laptop")).toBeGreaterThan(-1);
      expect(html.indexOf("lucide-laptop")).toBeLessThan(html.indexOf("lucide-terminal"));
      expect(summaryIcons([tool(rawInput, title) as unknown as AgentMessage])).toEqual([Laptop, Terminal]);
    }
    // A group of only zeros_workspace tools never shows the plug.
    const group = ["NotifyUser", "GetTerminalOutput", "GetWorkspaceDiff", "CreateReviewComment"].map(name => tool({ title: "t" }, `mcp__zeros_workspace__${name}`) as unknown as AgentMessage);
    expect(summaryIcons(group)).not.toContain(Plug);
    // A foreign MCP tool keeps it.
    expect(summaryIcons([tool({ server: "github", tool: "x", arguments: {} }, "github:x") as unknown as AgentMessage])).toContain(Plug);
  });

  it("removes Ran on <Mac> from a successful row and keeps plain words for every other ending", () => {
    const done = words(row(tool(args, "mcp__zeros_workspace__RunLocalCommand", "completed", "outcome: completed\nmac: Studio\nexit code: 0\n")));
    expect(done).toContain("List booted simulators");
    expect(done.join(" ")).not.toMatch(/Ran on/);
  });

  it("never shows a tool search while it is pending, for any query, and shows a finished one only when it loaded other tools", () => {
    const search = (rawInput: unknown, status: AgentToolMessage["status"], output?: unknown) =>
      ({ ...tool(rawInput, "ToolSearch", status, undefined, "tool_search"), ...(output ? { rawOutput: output } : {}) }) as AgentToolMessage;
    for (const status of ["pending", "in_progress"] as const)
      for (const input of [{}, { query: "" }, { query: "local command" }, { query: "select:ExitPlanMode" }])
        expect(toolPresentationReady(search(input, status))).toBe(false);
    expect(toolPresentationReady(search({ query: "select:ExitPlanMode" }, "completed"))).toBe(true);
    expect(toolPresentationReady(search({ query: "local command" }, "completed",
      [{ type: "tool_reference", tool_name: "mcp__zeros_workspace__RunLocalCommand" }]))).toBe(false);
    expect(toolPresentationReady(search({ query: "plan" }, "completed", [{ type: "tool_reference", tool_name: "ExitPlanMode" }]))).toBe(true);
  });

  it("says it waits for approval only while main holds this chat's approval for this command; otherwise a pending call is the running row", () => {
    const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
    const chatId = cloudScopedId(target, "chat-1");
    const rowIn = (message: AgentToolMessage, chat: string | null) => renderToStaticMarkup(createElement(TooltipProvider, {
      children: createElement(EventRowRenderer as never, { message, ctx: { editBaselines: new Map(), chatId: chat } }) }));
    const approval = { requestId: "r", workspaceId: target.workspaceId, workspaceName: "w-1", workspaceTitle: null, chatId: "chat-1", chatTitle: "Chat",
      macName: "Studio", command: args.command, timeoutMs: 60_000, approvalDeadline: "2026-11-11T10:00:00Z" } as LocalCommandApprovalView;
    const running = tool(args, "mcp__zeros_workspace__RunLocalCommand", "in_progress");
    try {
      acceptLocalCommandApprovalsForTests([]);   // Always allow: nothing waits
      expect(words(rowIn(running, chatId))).toEqual(["List booted simulators", "xcrun simctl list devices | grep Booted"]);
      acceptLocalCommandApprovalsForTests([approval]);
      expect(words(rowIn(running, chatId))).toContain("Waiting for approval on Studio");
      // Another chat's approval, or another command's, is not this row's.
      expect(rowIn(running, cloudScopedId(target, "chat-2"))).not.toContain("Waiting for approval");
      acceptLocalCommandApprovalsForTests([{ ...approval, command: "ls" }]);
      expect(rowIn(running, chatId)).not.toContain("Waiting for approval");
      // Arguments not known yet: the generic title, without any approval claim.
      acceptLocalCommandApprovalsForTests([]);
      expect(words(rowIn(tool({}, "mcp__zeros_workspace__RunLocalCommand", "pending"), chatId))).toEqual(["Run a command on your Mac"]);
    } finally { acceptLocalCommandApprovalsForTests([]); }
  });
});
