// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ notified: [] as string[], decided: [] as Array<[string, string]> }));
vi.mock("../../../platform/local-commands", async original => {
  const actual = await original<typeof import("../../../platform/local-commands")>();
  return { ...actual, startLocalCommandApprovals: () => {}, notifyLocalCommand: (id: string) => { state.notified.push(id); },
    decideLocalCommand: async (id: string, decision: string) => { state.decided.push([id, decision]); } };
});
vi.mock("../../../state/cloud-workspace-catalog", () => ({
  cloudWorkspaceDocumentById: (id: string) => id === "11111111-1111-4111-8111-111111111111" ? { id, organizationId: "22222222-2222-4222-8222-222222222222" } : undefined,
}));
import { acceptLocalCommandApprovalsForTests, resetLocalCommandApprovalsForTests, type LocalCommandApprovalView } from "../../../platform/local-commands";
import { LocalCommandApprovalHost, LocalCommandChatApprovals, approvalChatId } from "../local-command-approvals";
import { TooltipProvider } from "../../../shared/ui/primitives";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Array<{ unmount(): void }> = [];
afterEach(() => act(() => roots.splice(0).forEach(root => root.unmount())));
beforeEach(() => { state.notified = []; state.decided = []; resetLocalCommandApprovalsForTests(); });
const approval = (requestId: string, chatId: string, workspaceId = "11111111-1111-4111-8111-111111111111"): LocalCommandApprovalView => ({
  requestId, workspaceId, workspaceName: "w-7", workspaceTitle: "Fix login", chatId, chatTitle: "Simulator", macName: "Studio", command: `echo ${requestId}`,
  timeoutMs: 60_000, approvalDeadline: "2026-11-10T12:02:00.000Z" });
const scoped = (chat: string) => `cloud:22222222-2222-4222-8222-222222222222:11111111-1111-4111-8111-111111111111:${chat}`;
function mount(children: ReturnType<typeof createElement>) {
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node); roots.push(root);
  act(() => root.render(createElement(TooltipProvider, { children })));
  return node;
}

describe("local command approval surfaces", () => {
  it("maps an approval to its renderer chat once the workspace is known", () => {
    expect(approvalChatId(approval("r1", "chat-a"))).toBe(scoped("chat-a"));
    expect(approvalChatId(approval("r1", "chat-a", "99999999-9999-4999-8999-999999999999"))).toBeNull();
  });

  it("shows each approval once: in its visible chat, else in the app-wide host, which asks main for a notification", () => {
    acceptLocalCommandApprovalsForTests([approval("r1", "chat-a"), approval("r2", "chat-b")]);
    const host = mount(createElement(LocalCommandApprovalHost));
    expect(host.textContent).toContain("echo r1"); expect(host.textContent).toContain("echo r2");
    expect(state.notified.sort()).toEqual(["r1", "r2"]);
    const chat = mount(createElement(LocalCommandChatApprovals, { chatId: scoped("chat-a"), active: true }));
    expect(chat.textContent).toContain("echo r1"); expect(chat.textContent).not.toContain("echo r2");
    expect(host.textContent).not.toContain("echo r1"); expect(host.textContent).toContain("echo r2");
  });

  it("gives an inactive chat's approval back to the host, and relays a decision", () => {
    acceptLocalCommandApprovalsForTests([approval("r1", "chat-a")]);
    const host = mount(createElement(LocalCommandApprovalHost));
    const chat = mount(createElement(LocalCommandChatApprovals, { chatId: scoped("chat-a"), active: false }));
    expect(chat.textContent).toBe(""); expect(host.textContent).toContain("echo r1");
    const deny = [...host.querySelectorAll("button")].find(button => button.textContent === "Deny")!;
    act(() => deny.click());
    expect(state.decided).toEqual([["r1", "deny"]]);
  });
});
