import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";
import type { AgentSendFailureInput } from "../agent-send-failure-toast";
import { classifyCloudAdmissionFailure, type CloudAdmissionState } from "../cloud-admission-failure";

const mocks = vi.hoisted(() => ({ error: vi.fn(), log: vi.fn(), settings: vi.fn(), restart: vi.fn(),
  workspace: vi.fn(), account: vi.fn(), restartVisible: vi.fn(), accountAccess: vi.fn(),
  sessions: {} as Record<string, { cwd: string; cloudAdmissionFailure: CloudAdmissionState | null }>,
}));
vi.mock("../../../shared/ui/primitives/elements/toast", () => ({ toast: { error: mocks.error } }));
vi.mock("../../../platform/observability/logging/renderer-log", () => ({ logEvent: mocks.log }));
vi.mock("../cloud-admission-status", () => ({ openCloudAdmissionSettings: mocks.settings }));
vi.mock("../../../state/cloud-workspace-catalog", () => ({ cloudWorkspaceDocument: mocks.workspace, cloudCatalogGeneration: mocks.account }));
vi.mock("../../../state/cloud-workspace-restart", () => ({ restartCloudWorkspace: mocks.restart, cloudWorkspaceRestartVisible: mocks.restartVisible }));
vi.mock("../../team/cloud-workspace-account-access", () => ({ hasCloudWorkspaceAccountAccess: mocks.accountAccess }));
vi.mock("../sessions-store", () => ({ useSessionsStore: { getState: () => ({ sessions: mocks.sessions }) } }));

const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
let notify: typeof import("../agent-send-failure-toast").notifyAgentSendFailure;
const input = (error: unknown, extra: Partial<AgentSendFailureInput> = {}): AgentSendFailureInput => ({
  folder, chatId: "chat", attemptId: "turn", agentId: "codex", model: "gpt-6.1-sol", error, ...extra,
});

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.sessions = {};
  mocks.workspace.mockReturnValue(undefined);
  mocks.account.mockReturnValue(1);
  mocks.restartVisible.mockReturnValue(true);
  mocks.accountAccess.mockReturnValue(true);
  mocks.restart.mockResolvedValue(undefined);
  notify = (await import("../agent-send-failure-toast")).notifyAgentSendFailure;
});

describe("agent send failure toasts", () => {
  it("does not label uncertain delivery as Not sent in diagnostics", () => {
    notify(input("command_dispatch_rejected", { reason: "dispatch_ambiguous" }));
    expect(mocks.log).toHaveBeenCalledExactlyOnceWith("agent_send_uncertain", { reason: "dispatch_ambiguous" }, ["cloud", "agent"]);
  });

  it("records each explicit retry failure while preserving the original message identity", () => {
    const first = input(undefined, { reason: "history_unavailable", diagnosticAttemptId: "attempt-one" });
    notify(first); notify(first);
    notify({ ...first, diagnosticAttemptId: "attempt-two" });
    expect(mocks.log).toHaveBeenCalledTimes(2);
    expect(mocks.log.mock.calls.every(([event, detail]) => event === "agent_send_not_sent" &&
      JSON.stringify(detail) === JSON.stringify({ reason: "history_unavailable" }))).toBe(true);
  });

  it.each([
    ["command_conflict", "history_unavailable", "history_unavailable"],
    [undefined, "queued_timeout", "queued_timeout"],
    [undefined, "workspace_start_timeout", "workspace_start_timeout"],
    ["cloud_agent_credential_required", undefined, "credential_missing"],
    ["cloud_agent_credential_expired", undefined, "credential_expired_or_revoked"],
    ["cloud_agent_model_not_authorized", undefined, "model_not_enabled"],
    ["cloud_runtime_upgrade_required", undefined, "runtime_upgrade_required"],
  ] as const)("logs only a closed reason for %s/%s", (error, reason, expected) => {
    notify(input(error, { reason }));
    expect(mocks.log).toHaveBeenCalledExactlyOnceWith("agent_send_not_sent", { reason: expected }, ["cloud", "agent"]);
  });

  it.each(["/personal/project", "/organization/project"])("leaves %s failure logging unchanged", folder => {
    notify(input("private detail", { folder }));
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it.each([
    "cloud_workspace_v2_required", "cloud_runtime_upgrade_required", "cloud_agent_model_not_authorized",
    "cloud_agent_credential_required", "cloud_agent_credential_expired", "cloud_agent_credential_revoked",
    "cloud_agent_credential_refresh_required",
  ])("does not toast %s when the exact cloud chat already owns its failure banner", code => {
    mocks.sessions.chat = { cwd: folder, cloudAdmissionFailure: {
      ...classifyCloudAdmissionFailure({ folder, error: code, agentId: "codex", model: "gpt-6.1-sol" })!,
      code, turnId: "accepted-turn", agentId: "codex", model: "gpt-6.1-sol",
    } };
    // A flushed queue entry retains its notification UUID while admission is
    // owned by the accepted user-turn UUID. Both describe this same refusal.
    expect(notify(input(code, { attemptId: "original-queued-uuid" }))).toBe(false);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("does not hide a different workspace, chat, provider or admission cause behind another banner", () => {
    const code = "cloud_agent_credential_expired";
    mocks.sessions.chat = { cwd: folder, cloudAdmissionFailure: {
      ...classifyCloudAdmissionFailure({ folder, error: code, agentId: "codex" })!,
      code, turnId: "turn", agentId: "codex", model: "gpt-6.1-sol",
    } };
    expect(notify(input(code, { folder: folder.replace("22222222", "44444444") }))).toBe(true);
    expect(notify(input(code, { chatId: "other-chat" }))).toBe(true);
    expect(notify(input(code, { agentId: "claude", attemptId: "other-provider" }))).toBe(true);
    expect(notify(input("cloud_agent_credential_revoked", { attemptId: "other-cause" }))).toBe(true);
    expect(mocks.error).toHaveBeenCalledTimes(4);
  });

  it("keeps a suppressed banner acknowledgement separate from a later unrepresented attempt", () => {
    const code = "cloud_agent_credential_expired";
    mocks.sessions.chat = { cwd: folder, cloudAdmissionFailure: {
      ...classifyCloudAdmissionFailure({ folder, error: code, agentId: "codex" })!,
      code, turnId: "turn", agentId: "codex", model: "gpt-6.1-sol",
    } };
    expect(notify(input(code))).toBe(false);
    mocks.sessions.chat.cloudAdmissionFailure = null;
    expect(notify(input(code))).toBe(true);
    expect(mocks.error).toHaveBeenCalledOnce();
  });

  it("retains ordinary queue feedback when the cloud session has no admission failure", () => {
    mocks.sessions.chat = { cwd: folder, cloudAdmissionFailure: null };
    expect(notify(input(undefined, { reason: "queued_timeout" }))).toBe(true);
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("Message wasn't sent in time", expect.any(Object));
  });

  it.each([
    ["cloud_workspace_v2_required", "This workspace uses a retired cloud runtime", undefined],
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
    ["retired_runtime", "This workspace uses a retired cloud runtime", undefined],
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
});
