import { describe, expect, it } from "vitest";
import {
  CLOUD_COMMAND_FAILURE_STAGES, CLOUD_COMMAND_FAILURE_CATEGORIES, CloudCommandEntrySchema, CloudNativeResultSchema,
  encodeCloudCommandFailure, decodeCloudCommandFailure, cloudCommandFailureFromCode,
} from "../cloud-commands";

describe("closed cloud command failure causes", () => {
  it("retains a bounded exact terminal in native receipts without requiring it from legacy results",()=>{
    const terminal={commandId:"11111111-1111-4111-8111-111111111111",conversationId:"conversation",executionId:"execution",turnId:"turn",agentId:"claude",
      status:"failed",stopReason:"blocking_limit",response:{stopReason:"blocking_limit",effectiveModel:"claude-haiku-4-5",usage:{inputTokens:7,outputTokens:3,totalCostUsd:0.01}},
      failure:{kind:"rate-limited",message:"Synthetic usage limit",stage:"prompt"},startedAt:1,endedAt:2};
    expect(CloudNativeResultSchema.parse({version:1,terminal})).toEqual({version:1,terminal});
    expect(CloudNativeResultSchema.parse({version:1})).toEqual({version:1});
  });
  it.each(["executor_start_failed", "provider_login_failed", "environment_setup_failed", "environment_identity_mismatch", "environment_not_ready",
    "credential_refresh_invalid", "credential_refresh_timeout", "credential_refresh_unchanged", "credential_refresh_rejected", "lock_busy", "execution_limit",
    "customization_changed", "access_denied", "environment_revoked", "environment_runtime_required", "environment_unavailable", "lease_expired"])("decodes and provides actionable guidance for %s", category => {
    const code = `cloud_validation_${category}`;
    expect(decodeCloudCommandFailure(code)).toEqual({ stage: "validation", category });
    expect(cloudCommandFailureFromCode(code)?.message).not.toContain("Review the conversation before retrying");
    expect(cloudCommandFailureFromCode(code)?.message).toContain(category);
  });
  it.each(["cloud_validation_authority_unavailable", "cloud_admission_authority_timeout", "cloud_containment_canary_failed", "cloud_provider_start_auth_required", "cloud_provider_prompt_rate_limited"])("keeps decoding legacy cause %s", code => {
    expect(decodeCloudCommandFailure(code)).not.toBeNull();
  });
  it("round-trips every safe stage/category through the existing receipt field", () => {
    for (const stage of CLOUD_COMMAND_FAILURE_STAGES) for (const category of CLOUD_COMMAND_FAILURE_CATEGORIES) {
      const code = encodeCloudCommandFailure({ stage, category });
      expect(code.length).toBeLessThanOrEqual(64);
      expect(decodeCloudCommandFailure(code)).toEqual({ stage, category });
      const entry = { commandId: "11111111-1111-4111-8111-111111111111", position: 1, state: "failed", payload: null,
        executionId: "execution", generation: 1, resultCode: code, createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z" };
      expect(CloudCommandEntrySchema.parse(entry).resultCode).toBe(code);
    }
  });
  it.each([null, {}, "cloud_provider_prompt_private_text", "cloud_unknown_timeout", "prefix_cloud_admission_rejected",
    "cloud_admission_rejected\nprivate diagnostic", "command_dispatch_rejected"])("does not decode untyped diagnostics: %s", value => {
    expect(decodeCloudCommandFailure(value)).toBeNull();
    expect(cloudCommandFailureFromCode(value, "claude")).toBeNull();
  });
  it.each([
    ["verification_required", "verification-required"],
    ["cloud_credential_error", "cloud-credentials-unavailable"],
  ] as const)("keeps %s structured after native event loss", (category, kind) => {
    expect(cloudCommandFailureFromCode(encodeCloudCommandFailure({ stage: "provider_prompt", category }), "claude"))
      .toMatchObject({ kind, agentId: "claude", stage: "prompt", message: expect.any(String) });
  });
});
