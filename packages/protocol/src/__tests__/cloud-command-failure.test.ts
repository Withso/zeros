import { describe, expect, it } from "vitest";
import {
  CLOUD_COMMAND_FAILURE_STAGES, CLOUD_COMMAND_FAILURE_CATEGORIES, CloudCommandEntrySchema,
  encodeCloudCommandFailure, decodeCloudCommandFailure, cloudCommandFailureFromCode,
} from "../cloud-commands";

describe("closed cloud command failure causes", () => {
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
