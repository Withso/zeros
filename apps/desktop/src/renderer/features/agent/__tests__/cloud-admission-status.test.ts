import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  organization: "11111111-1111-4111-8111-111111111111", settings: vi.fn(), dispatch: vi.fn(), retry: vi.fn(),
  buttons: [] as Array<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }>,
}));
vi.mock("../../team/team-store", () => ({ getActiveOrganizationIdSnapshot: () => mocks.organization }));
vi.mock("../../settings/settings-navigation", () => ({ requestProviderSettings: mocks.settings }));
vi.mock("../../../state/store", () => ({ useWorkspaceStore: { getState: () => ({ dispatch: mocks.dispatch }) } }));
vi.mock("../../../shared/ui/primitives/button", () => ({
  Button: (props: (typeof mocks.buttons)[number]) => {
    mocks.buttons.push(props);
    return createElement("button", props, props.children);
  },
}));
import { openCloudAdmissionSettings } from "../cloud-admission-status";
import { classifyCloudAdmissionFailure, type CloudAdmissionFailure } from "../cloud-admission-failure";
import { TurnFailureCard } from "../turn-failure-card";
const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const renderAdmission = (cloudAdmission: CloudAdmissionFailure, overrides: Partial<Parameters<typeof TurnFailureCard>[0]> = {}) =>
  renderToStaticMarkup(createElement(TurnFailureCard, {
    failure: { kind: "cloud-admission", message: cloudAdmission.message, newChatAllowed: false },
    folder, agentId: "codex", cloudAdmission, onRetry: mocks.retry, onRetryNewChat: vi.fn(), ...overrides,
  }));
beforeEach(() => { vi.clearAllMocks(); mocks.buttons.length = 0; mocks.organization = "11111111-1111-4111-8111-111111111111"; });
describe("cloud admission failure banner", () => {
  it.each([
    ["cloud_runtime_upgrade_required", "next time it wakes", null],
    ["cloud_agent_model_not_authorized", "GPT-6.1 Sol", null],
    ["cloud_agent_credential_required", "Connect Codex", "Reconnect"],
    ["cloud_agent_credential_expired", "expired", "Reconnect"],
    ["cloud_agent_credential_refresh_required", "needs to be renewed", "Reconnect"],
    ["cloud_agent_credential_revoked", "disconnected", "Reconnect"],
    ["command_dispatch_rejected", "Review the conversation", null],
  ])("presents %s once in the existing error banner with its recovery action", (code, message, action) => {
    const failure = classifyCloudAdmissionFailure({ folder, error: code, model: "gpt-6.1-sol", agentId: "codex" });
    const html = renderAdmission(failure!);
    expect(html).toContain(message!);
    expect(html.match(/data-turn-failure-card/g)).toHaveLength(1);
    expect(html).toContain("bg-brown-bg");
    expect(html).not.toContain(code!); expect(html).not.toContain("AGENT STOPPED"); expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("data-cloud-admission-status");
    expect(html).not.toContain("Enable models");
    expect(html).not.toContain("Or choose an allowed model.");
    expect(html).not.toContain("Retry in new chat");
    if (action) expect(html).toContain(action); else expect(html).not.toContain("<button");
  });
  it.each(["/personal/local", "/organization/local"])("does not render or navigate for %s", folder => {
    const failure = { kind: "credential-required" as const, message: "Reconnect", action: "reconnect" as const };
    expect(renderAdmission(failure, { folder })).toBe("");
    openCloudAdmissionSettings(folder, "codex");
    expect(mocks.settings).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("leaves expected waiting to the queue", () => {
    const failure = classifyCloudAdmissionFailure({ folder, error: "cloud_workspace_not_ready" });
    expect(renderAdmission(failure!)).toBe("");
  });
  it("routes the banner's Reconnect action to this provider's settings", () => {
    renderAdmission(classifyCloudAdmissionFailure({ folder, error: "cloud_agent_credential_expired", agentId: "codex" })!);
    expect(mocks.buttons).toHaveLength(1);
    expect(mocks.buttons[0].disabled).toBe(false);
    mocks.buttons[0].onClick?.();
    expect(mocks.settings).toHaveBeenCalledExactlyOnceWith("codex");
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "SET_ACTIVE_PAGE", page: "settings" });
    expect(mocks.retry).not.toHaveBeenCalled();
  });
  it("only retries an explicitly retryable admission and never starts a new chat", () => {
    const html = renderAdmission({ kind: "unavailable", message: "The agent is temporarily unavailable", action: "retry" });
    expect(html).toContain("Try again");
    expect(html).not.toContain("Retry in new chat");
    expect(mocks.buttons).toHaveLength(1);
    mocks.buttons[0].onClick?.();
    expect(mocks.retry).toHaveBeenCalledOnce();
    expect(mocks.settings).not.toHaveBeenCalled();
  });
  it("preserves the refusal in read-only history without exposing recovery actions", () => {
    const html = renderAdmission(classifyCloudAdmissionFailure({ folder, error: "cloud_agent_credential_expired", agentId: "codex" })!, { readOnly: true });
    expect(html).toContain("connection expired");
    expect(html).toContain("data-turn-failure-card");
    expect(mocks.buttons).toHaveLength(0);
  });
  it("disables Reconnect after switching owners and rechecks ownership on click", () => {
    mocks.organization = "33333333-3333-4333-8333-333333333333";
    renderAdmission(classifyCloudAdmissionFailure({ folder, error: "cloud_agent_credential_expired", agentId: "codex" })!);
    expect(mocks.buttons[0]?.disabled).toBe(true);
    mocks.buttons[0]?.onClick?.();
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("opens only the exact active cloud owner's provider settings, including A to B to A", () => {
    openCloudAdmissionSettings(folder, "codex");
    expect(mocks.settings).toHaveBeenCalledWith("codex");
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: "SET_ACTIVE_PAGE", page: "settings" });
    mocks.organization = "33333333-3333-4333-8333-333333333333";
    openCloudAdmissionSettings(folder, "claude"); expect(mocks.settings).toHaveBeenCalledTimes(1);
    mocks.organization = "11111111-1111-4111-8111-111111111111";
    openCloudAdmissionSettings(folder, "cursor"); expect(mocks.settings).toHaveBeenLastCalledWith("cursor");
  });
});
