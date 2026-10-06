import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";
import type { AgentSendFailureInput } from "../agent-send-failure-toast";

const mocks = vi.hoisted(() => ({ error: vi.fn(), settings: vi.fn(), restart: vi.fn(),
  workspace: vi.fn(), account: vi.fn(), restartVisible: vi.fn(), internalFeature: vi.fn() }));
vi.mock("../../../shared/ui/primitives/elements/toast", () => ({ toast: { error: mocks.error } }));
vi.mock("../cloud-admission-status", () => ({ openCloudAdmissionSettings: mocks.settings }));
vi.mock("../../../state/cloud-workspace-catalog", () => ({ cloudWorkspaceDocument: mocks.workspace, cloudCatalogGeneration: mocks.account }));
vi.mock("../../../state/cloud-workspace-restart", () => ({ restartCloudWorkspace: mocks.restart, cloudWorkspaceRestartVisible: mocks.restartVisible }));
vi.mock("../../settings/internal-features", () => ({ isInternalFeatureActive: mocks.internalFeature }));

const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
let notify: typeof import("../agent-send-failure-toast").notifyAgentSendFailure;
const input = (error: unknown, extra: Partial<AgentSendFailureInput> = {}): AgentSendFailureInput => ({
  folder, chatId: "chat", attemptId: "turn", agentId: "codex", model: "gpt-6.1-sol", error, ...extra,
});

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.workspace.mockReturnValue(undefined);
  mocks.account.mockReturnValue(1);
  mocks.restartVisible.mockReturnValue(true);
  mocks.internalFeature.mockReturnValue(true);
  mocks.restart.mockResolvedValue(undefined);
  notify = (await import("../agent-send-failure-toast")).notifyAgentSendFailure;
});

describe("agent send failure toasts", () => {
  it.each([
    ["cloud_runtime_upgrade_required", "This workspace is on an older runtime", undefined],
    ["cloud_agent_model_not_authorized", "GPT-6.1 Sol isn't enabled for this workspace", "Agent settings"],
    ["cloud_agent_credential_required", "Connect Codex to send messages", "Reconnect"],
    ["cloud_agent_credential_expired", "Reconnect Codex to send messages", "Reconnect"],
    ["cloud_agent_credential_revoked", "Reconnect Codex to send messages", "Reconnect"],
    ["cloud_agent_credential_refresh_required", "Your Codex connection needs to be renewed", "Reconnect"],
    ["command_dispatch_rejected", "Cloud request couldn't be completed", undefined],
    ["cloud_agent_authority_rejected", "Cloud request couldn't be completed", undefined],
  ])("maps %s to short copy and one relevant action", (code, message, action) => {
    expect(notify(input({ code }))).toBe(true);
    expect(mocks.error).toHaveBeenCalledOnce();
    const [copy, options] = mocks.error.mock.calls[0];
    expect(copy).toBe(message);
    expect(JSON.stringify(options)).not.toContain(code);
    expect(options.action?.label).toBe(action);
    if (action) {
      options.action.onClick();
      expect(mocks.settings).toHaveBeenCalledExactlyOnceWith(folder, "codex");
    }
    if (isCloudAgentAdmissionCode(code)) {
      for (const reason of ["dispatch_ambiguous", "unknown"] as const) {
        notify(input({ code, message: "command_dispatch_rejected" }, { reason, attemptId: reason }));
        expect(mocks.error).toHaveBeenLastCalledWith(message, expect.objectContaining({
          action: action ? expect.objectContaining({ label: action }) : undefined,
        }));
      }
    }
  });

  it("deduplicates by exact workspace, chat and turn/command identity, independent of cause", () => {
    const failed = input("cloud_agent_credential_expired");
    notify(failed);
    mocks.error.mockClear(); // Dismissing a toast does not release the identity.
    expect(notify({ ...failed })).toBe(false);
    expect(notify({ ...failed, error: "command_dispatch_rejected" })).toBe(false);
    expect(mocks.error).not.toHaveBeenCalled();
    expect(notify({ ...failed, attemptId: "next-turn" })).toBe(true);
    expect(notify({ ...failed, chatId: "other-chat" })).toBe(true);
    expect(notify({ ...failed, folder: folder.replace("22222222", "44444444") })).toBe(true);
    expect(mocks.error).toHaveBeenCalledTimes(3);
  });

  it("notifies once per blocked runtime state across reconnects, refreshes and A to B to A", () => {
    const blocked = input("cloud_runtime_upgrade_required", { attemptId: "runtime-upgrade:codex:1" });
    for (let attempt = 0; attempt < 5; attempt++) notify({ ...blocked });
    notify({ ...blocked, folder: folder.replace("11111111", "33333333") });
    expect(notify(blocked)).toBe(false);
    expect(mocks.error).toHaveBeenCalledTimes(2);
    expect(notify({ ...blocked, attemptId: "runtime-upgrade:codex:2" })).toBe(true);
  });

  it.each(["cloud_workspace_not_ready", "cloud_workspace_waking", "CLOUD_WORKSPACE_NOT_READY", "CLOUD_WORKSPACE_CHECKPOINTING"])("leaves %s to the waiting card, without consuming the send identity", error => {
    expect(notify(input(error))).toBe(false);
    expect(mocks.error).not.toHaveBeenCalled();
    expect(notify(input("cloud_agent_credential_required"))).toBe(true);
  });

  it("maps a queued-send timeout through the same one-time surface", () => {
    const timeout = input(new Error("private diagnostic"), { reason: "queued_timeout" });
    expect(notify(timeout)).toBe(true);
    expect(notify({ ...timeout, error: "cloud_workspace_not_ready" })).toBe(false);
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("Message wasn't sent in time", expect.objectContaining({
      description: "Try sending again when the workspace is ready.",
    }));
  });

  it.each([new Error("private diagnostic"), { code: "unknown_code", message: "private diagnostic" }])("never exposes unknown codes or raw diagnostics", error => {
    notify(input(error));
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("Message wasn't sent", expect.objectContaining({
      description: "Review the conversation before retrying.",
    }));
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain("private diagnostic");
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain("unknown_code");
  });

  it.each(["/personal/local", "/organization/local"])("never presents cloud credential or runtime advice for %s", folder => {
    notify(input("cloud_agent_credential_expired", { folder }));
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("Message wasn't sent", expect.objectContaining({ action: undefined }));
    expect(mocks.settings).not.toHaveBeenCalled();
  });

  it.each([
    ["queued_timeout", "Message wasn't sent in time", "Retry"],
    ["workspace_stopped", "Cloud workspace stopped", "Retry"],
    ["workspace_archived", "Cloud workspace is archived", undefined],
    ["workspace_unavailable", "Cloud workspace is unavailable", "Retry"],
    ["runtime_upgrade_required", "This workspace is on an older runtime", undefined],
    ["model_not_enabled", "GPT-6.1 Sol isn't enabled for this workspace", "Agent settings"],
    ["credential_missing", "Connect Codex to send messages", "Reconnect"],
    ["credential_expired_or_revoked", "Reconnect Codex to send messages", "Reconnect"],
    ["credential_refresh_required", "Your Codex connection needs to be renewed", "Reconnect"],
    ["dispatch_ambiguous", "Cloud request couldn't be completed", undefined],
    ["unknown", "Message wasn't sent", undefined],
  ] as const)("accepts IW2's normalized %s with only its relevant action", (reason, message, label) => {
    const retry = vi.fn();
    expect(notify(input(undefined, { reason, onRetry: retry }))).toBe(true);
    const [copy, options] = mocks.error.mock.calls[0];
    expect(copy).toBe(message);
    expect(options.action?.label).toBe(label);
    if (label === "Retry") {
      options.action.onClick();
      expect(retry).toHaveBeenCalledOnce();
      expect(mocks.settings).not.toHaveBeenCalled();
    }
  });

  it("shares queue UUID dedupe with the promoted turn, even when its failure reason changes", () => {
    const queued = input(undefined, { attemptId: "queued-message-uuid", reason: "queued_timeout" });
    expect(notify(queued)).toBe(true);
    expect(notify({ ...queued, reason: "credential_missing" })).toBe(false);
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it.each(["admission", "normalized"])("wires %s runtime failure to an explicit restart of the captured cloud workspace", source => {
    mocks.workspace.mockReturnValue({ capabilities: { canWrite: true } });
    const retry = vi.fn();
    notify(input(source === "admission" ? "cloud_runtime_upgrade_required" : undefined,
      { reason: "runtime_upgrade_required", onRetry: retry }));
    const [copy, options] = mocks.error.mock.calls[0];
    expect(copy).toBe("This workspace is on an older runtime");
    expect(options.description).toBe("Restart this workspace to update its cloud runtime.");
    expect(options.description).not.toContain("next time");
    expect(options.action.label).toBe("Restart workspace");
    expect(mocks.restart).not.toHaveBeenCalled();
    options.action.onClick();
    expect(mocks.restart).toHaveBeenCalledExactlyOnceWith({
      organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
      relativePath: "",
    });
    expect(retry).not.toHaveBeenCalled();
  });

  it("preserves the named restart hook behind the same cloud permission gate", () => {
    mocks.workspace.mockReturnValue({ capabilities: { canWrite: true } });
    const restart = vi.fn(), retry = vi.fn();
    notify(input("cloud_runtime_upgrade_required", { onRestartWorkspace: restart, onRetry: retry }));
    const [copy, options] = mocks.error.mock.calls[0];
    expect(copy).toBe("This workspace is on an older runtime");
    expect(options.action.label).toBe("Restart workspace");
    expect(restart).not.toHaveBeenCalled();
    options.action.onClick();
    expect(restart).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it.each(["no-write", "no-document", "archived", "feature-off", "personal-local", "organization-local"])("offers no runtime restart for %s even with a caller hook", state => {
    mocks.workspace.mockReturnValue(state === "no-document" ? undefined : { capabilities: { canWrite: state !== "no-write" } });
    mocks.restartVisible.mockReturnValue(state !== "archived");
    mocks.internalFeature.mockReturnValue(state !== "feature-off");
    const restart = vi.fn();
    notify(input("cloud_runtime_upgrade_required", {
      folder: state.endsWith("local") ? `/${state}` : folder, onRestartWorkspace: restart,
    }));
    expect(mocks.error.mock.calls[0][1].action).toBeUndefined();
    expect(restart).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it.each(["account", "write-access", "lifecycle"])("retires a captured runtime restart action after %s changes", change => {
    mocks.workspace.mockReturnValue({ capabilities: { canWrite: true } });
    notify(input("cloud_runtime_upgrade_required"));
    const action = mocks.error.mock.calls[0][1].action;
    expect(action.label).toBe("Restart workspace");
    if (change === "account") mocks.account.mockReturnValue(2);
    if (change === "write-access") mocks.workspace.mockReturnValue({ capabilities: { canWrite: false } });
    if (change === "lifecycle") mocks.restartVisible.mockReturnValue(false);
    action.onClick();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it("leaves restart failure presentation with the shared restart owner", async () => {
    mocks.workspace.mockReturnValue({ capabilities: { canWrite: true } });
    mocks.restart.mockRejectedValue(new Error("Fixture restart failed"));
    notify(input("cloud_runtime_upgrade_required"));
    await mocks.error.mock.calls[0][1].action.onClick();
    expect(mocks.restart).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledOnce();
  });
});
