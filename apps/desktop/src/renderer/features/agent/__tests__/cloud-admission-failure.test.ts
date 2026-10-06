import { describe, expect, it } from "vitest";
import { classifyCloudAdmissionFailure, cloudAdmissionForTurn } from "../cloud-admission-failure";
const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const classify = (error: unknown, cwd = folder) => classifyCloudAdmissionFailure({ folder: cwd, error, model: "gpt-6.1-sol", agentId: "codex" });
describe("cloud admission presentation", () => {
  it.each([
    ["cloud_runtime_upgrade_required", "runtime-upgrade-required", "This workspace gets the new cloud runtime the next time it wakes", "none"],
    ["cloud_agent_model_not_authorized", "model-not-authorized", "GPT-6.1 Sol isn't enabled for this workspace", "choose-model"],
    ["cloud_agent_credential_required", "credential-required", "Connect Codex to use agents in this workspace", "reconnect"],
    ["cloud_agent_credential_expired", "credential-required", "Your Codex connection expired. Reconnect to continue", "reconnect"],
    ["cloud_agent_credential_refresh_required", "credential-required", "Your Codex connection needs to be renewed. Reconnect to continue", "reconnect"],
    ["cloud_agent_credential_revoked", "credential-required", "Your Codex connection was disconnected. Reconnect to continue", "reconnect"],
    ["cloud_workspace_not_ready", "waiting", "Waiting for agent", "none"],
    ["CLOUD_WORKSPACE_CHECKPOINTING", "waiting", "Waiting for agent", "none"],
    ["command_dispatch_rejected", "unavailable", "The cloud agent request could not be completed. Review the conversation before trying again", "none"],
    ["The cloud command outcome is unknown. Review the transcript before retrying.", "unavailable", "The cloud agent request could not be completed. Review the conversation before trying again", "none"],
  ])("maps only the closed cause %s", (code, kind, message, action) => {
    expect(classify({ code })).toMatchObject({ kind, message, action });
    expect(classify(new Error(code))).toEqual(classify({ code }));
    expect(classify(code)).toEqual(classify({ code }));
  });
  it("does not reinterpret provider errors, raw diagnostics, or unknown codes as sign-in failures", () => {
    expect(classify("private provider text mentioning cloud_agent_credential_expired")).toBeNull();
    expect(classify({ code: "unknown_code", message: "Cloud agent execution authority is unavailable" })).toBeNull();
    expect(classify({ code: "agent_prompt_failed" })).toBeNull();
  });
  it.each(["/personal/repo", "/organization/repo"])("leaves local workspaces at %s untouched", cwd => {
    expect(classify("cloud_runtime_upgrade_required", cwd)).toBeNull();
    expect(classify("cloud_agent_model_not_authorized", cwd)).toBeNull();
    expect(classify("cloud_agent_credential_required", cwd)).toBeNull();
  });
});

it("owns only the exact rejected cloud turn, including durable replay", () => {
  const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  const recoveryFailure = { kind: "cloud-admission", message: "cloud_agent_model_not_authorized" };
  expect(cloudAdmissionForTurn({ folder, turnId: "turn", recoveryFailure, agentId: "codex" })?.kind).toBe("model-not-authorized");
  for (const folder of ["/personal/local", "/organization/local"])
    expect(cloudAdmissionForTurn({ folder, turnId: "turn", recoveryFailure })).toBeNull();
  const current = { ...classifyCloudAdmissionFailure({ folder, error: "cloud_agent_credential_expired" })!,
    turnId: "other", code: "cloud_agent_credential_expired", agentId: "codex", model: null };
  expect(cloudAdmissionForTurn({ folder, turnId: "turn", current })).toBeNull();
  expect(cloudAdmissionForTurn({ folder, turnId: "other", current })?.kind).toBe("credential-required");
});

it("renders empty and leading system turns without inventing an admission", () => {
  for (const folder of ["/personal/local", "/organization/local", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222"])
    expect(cloudAdmissionForTurn({ folder, turnId: undefined })).toBeNull();
});
