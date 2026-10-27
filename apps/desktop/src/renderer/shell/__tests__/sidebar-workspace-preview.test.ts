import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../features/agent/use-agent-session";
import type { Workspace } from "../../platform/git";
import type { ChatThread } from "../../state/store";
import { sidebarPreviewChat, sidebarPreviewText, sidebarWorkspaceDisplayId } from "../sidebar-workspace-preview";

const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const chat = (id: string, folder: string, updatedAt: number, extra: Partial<ChatThread> = {}) =>
  ({ id, folder, updatedAt, title: id, ...extra }) as ChatThread;
const text = (value: string, extra = {}): AgentMessage =>
  ({ id: value, kind: "text", role: "agent", text: value, createdAt: 1, ...extra });

describe("sidebar workspace preview identity", () => {
  it.each([
    ["Personal", "/workspaces/local", null],
    ["organization Local", "/workspaces/org", "organization"],
    ["cloud", cloud, "11111111-1111-4111-8111-111111111111"],
  ])("selects the latest eligible chat for %s without crossing owners", (_name, path, organizationId) => {
    const workspace = { id: "workspace", path, organizationId } as Workspace;
    const latest = chat("latest", path!, 20);
    const rows = [chat("older", path!, 10), latest,
      chat("foreign", "/other", 100), chat("nested", `${path}/nested`, 100),
      chat("archived", path!, 100, { archived: true }),
      chat("terminal", path!, 100, { kind: "terminal" })];
    const ids = ["older", "latest", "foreign", "archived", "terminal"];
    expect(sidebarPreviewChat(workspace, ids, rows)).toBe(latest);
    expect(sidebarPreviewChat({ ...workspace, path: "/other-owner" }, ids, rows)).toBeNull();
    expect(sidebarPreviewChat(workspace, ids, rows)).toBe(latest);
  });

  it("shows the workspace part of a cloud identity, never its owner or VM path", () => {
    expect(sidebarWorkspaceDisplayId({ id: cloud, path: cloud } as Workspace)).toBe("22222222");
    expect(sidebarWorkspaceDisplayId({ id: "W-234", path: "/local" } as Workspace)).toBe("W-234");
  });
});

describe("latest activity preview", () => {
  it("skips hidden reasoning, retracted output, child activity and unsent queued prompts", () => {
    expect(sidebarPreviewText([
      text("Confirmed\n\nreply"), text("thought", { role: "thought" }),
      text("withdrawn", { retracted: true }), text("child", { parentToolId: "parent" }),
      text("later prompt", { role: "user", queued: true }),
    ])).toBe("Confirmed reply");
  });

  it("keeps a ready native tool or failure as the latest activity", () => {
    const tool: AgentMessage = { id: "tool", kind: "tool", toolCallId: "tool", title: "Run workspace tests", toolKind: "execute", status: "in_progress", createdAt: 2, updatedAt: 2 };
    expect(sidebarPreviewText([text("Checking"), tool])).toBe("Run workspace tests");
    expect(sidebarPreviewText([text("Checking"), { ...tool, title: "Bash", rawInput: undefined }])).toBe("Checking");
    expect(sidebarPreviewText([tool, { id: "failure", kind: "error_notice", message: "Could not finish the check", severity: "error", recoverable: false, createdAt: 3 }])).toBe("Could not finish the check");
  });

  it("does not replace useful activity with native sleep bookkeeping", () => {
    const native = { type: "sleep", id: "native", durationMs: 1000 };
    expect(sidebarPreviewText([text("Reviewing changes"), {
      id: "sleep", kind: "tool", toolCallId: "sleep", nativeToolCallId: "native", title: "Sleep", toolKind: "other", status: "completed", rawInput: native, rawOutput: native, createdAt: 2, updatedAt: 3,
    }])).toBe("Reviewing changes");
  });

  it("bounds plain provider text without interpreting markup and returns an empty fallback", () => {
    expect(sidebarPreviewText([text("<script>example</script>")])).toBe("<script>example</script>");
    expect(sidebarPreviewText([text("x".repeat(20_000))])).toHaveLength(400);
    expect(sidebarPreviewText([])).toBe("");
  });
});
