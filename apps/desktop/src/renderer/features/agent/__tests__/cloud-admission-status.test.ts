import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ organization: "11111111-1111-4111-8111-111111111111", settings: vi.fn(), dispatch: vi.fn() }));
vi.mock("../../team/team-store", () => ({ getActiveOrganizationIdSnapshot: () => mocks.organization }));
vi.mock("../../settings/settings-navigation", () => ({ requestProviderSettings: mocks.settings }));
vi.mock("../../../state/store", () => ({ useWorkspaceStore: { getState: () => ({ dispatch: mocks.dispatch }) } }));
import { CloudAdmissionStatus, openCloudAdmissionSettings } from "../cloud-admission-status";
import { classifyCloudAdmissionFailure } from "../cloud-admission-failure";
const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
beforeEach(() => { vi.clearAllMocks(); mocks.organization = "11111111-1111-4111-8111-111111111111"; });
describe("cloud admission status", () => {
  it.each([
    ["cloud_runtime_upgrade_required", "next time it wakes", null],
    ["cloud_agent_model_not_authorized", "GPT-6.1 Sol", "Enable models"],
    ["cloud_agent_credential_required", "Connect Codex", "Reconnect"],
    ["cloud_agent_credential_expired", "expired", "Reconnect"],
    ["cloud_agent_credential_refresh_required", "needs to be renewed", "Reconnect"],
    ["cloud_agent_credential_revoked", "disconnected", "Reconnect"],
    ["command_dispatch_rejected", "Review the conversation", null],
  ])("presents %s as one precise status and action", (code, message, action) => {
    const failure = classifyCloudAdmissionFailure({ folder, error: code, model: "gpt-6.1-sol", agentId: "codex" });
    const html = renderToStaticMarkup(createElement(CloudAdmissionStatus, { folder, agentId: "codex", failure, onRetry: () => {} }));
    expect(html).toContain(message!);
    expect(html).not.toContain(code!); expect(html).not.toContain("AGENT STOPPED"); expect(html).not.toContain('role="alert"');
    if (action) expect(html).toContain(action); else expect(html).not.toContain("<button");
  });
  it.each(["/personal/local", "/organization/local"])("does not render or navigate for %s", folder => {
    const failure = { kind: "credential-required" as const, message: "Reconnect", action: "reconnect" as const };
    expect(renderToStaticMarkup(createElement(CloudAdmissionStatus, { folder, failure }))).toBe("");
    openCloudAdmissionSettings(folder, "codex");
    expect(mocks.settings).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("leaves expected waiting to the queue", () => {
    const failure = classifyCloudAdmissionFailure({ folder, error: "cloud_workspace_not_ready" });
    expect(renderToStaticMarkup(createElement(CloudAdmissionStatus, { folder, failure }))).toBe("");
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
