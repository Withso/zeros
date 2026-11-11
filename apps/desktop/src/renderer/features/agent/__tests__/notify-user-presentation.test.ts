import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import { notifyUserLabel } from "../renderers/notify-user-presentation";
import { metaForEvent } from "../renderers/event-meta";

const args = { title: "Ready for review", message: "The login fix is ready.", kind: "review" };
const tool = (rawInput: unknown, title: string, status = "completed") =>
  ({ kind: "tool", toolKind: "mcp", title, status, rawInput, content: [] }) as unknown as AgentToolMessage;

describe("NotifyUser presentation", () => {
  it.each([
    { rawInput: { server: "zeros_workspace", tool: "NotifyUser", arguments: args }, title: "zeros_workspace:NotifyUser" },
    { rawInput: args, title: "mcp__zeros_workspace__NotifyUser" },
    { rawInput: { providerIdentifier: "zeros_workspace", toolName: "NotifyUser", args }, title: "MCP NotifyUser" },
  ])("reads every adapter's shape as 'Notified you: <title>' ($title)", ({ rawInput, title }) => {
    expect(notifyUserLabel(tool(rawInput, title))).toBe("Notified you: Ready for review");
    expect(metaForEvent(tool(rawInput, title) as unknown as AgentMessage).label).toBe("Notified you: Ready for review");
  });

  it("never claims a foreign server's or an unqualified tool, and says when it was not sent", () => {
    expect(notifyUserLabel(tool({ server: "foreign", tool: "NotifyUser", arguments: args }, "mcp__zeros_workspace__NotifyUser"))).toBeNull();
    expect(notifyUserLabel(tool(args, "NotifyUser"))).toBeNull();
    expect(notifyUserLabel(tool(args, "mcp__zeros_workspace__NotifyUser", "failed"))).toBe("Notification not sent");
    // The row itself shows the shared red "Error" label; the target names what was not sent.
    expect(metaForEvent(tool(args, "mcp__zeros_workspace__NotifyUser", "failed") as unknown as AgentMessage).target).toBe("Ready for review");
    expect(metaForEvent(tool(args, "mcp__zeros_workspace__NotifyUser") as unknown as AgentMessage).target).toBeUndefined();
  });
});
