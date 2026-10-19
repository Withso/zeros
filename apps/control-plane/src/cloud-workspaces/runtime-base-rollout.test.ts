import { describe, expect, it } from "vitest";
import { loadCloudRuntimeConfig } from "./runtime-config.js";

const fixture = "11111111-1111-4111-8111-111111111111";
const policy = { version: 1, defaultBaseImageId: "zeros-v2-test-default", candidate: {
  baseImageId: "zeros-v2-test-candidate", organizationIds: [fixture],
} };

describe("runtime base rollout configuration", () => {
  it("is byte-for-byte compatible in shape when the variable is absent", () => {
    expect(loadCloudRuntimeConfig({})).toEqual({ qualificationMode: "full", qualificationEnabled: false,
      stagingEnabled: false, imagesEnabled: false });
  });

  it("loads one bounded explicit default and candidate without enabling any worker", () => {
    expect(loadCloudRuntimeConfig({ CLOUD_RUNTIME_BASE_ROLLOUT_JSON: JSON.stringify(policy) })).toEqual({
      qualificationMode: "full", qualificationEnabled: false, stagingEnabled: false, imagesEnabled: false,
      baseRollout: policy,
    });
    expect(loadCloudRuntimeConfig({ CLOUD_RUNTIME_BASE_ROLLOUT_JSON: JSON.stringify({ ...policy, candidate: null }) }))
      .toHaveProperty("baseRollout.candidate", null);
  });

  it("canonicalizes organization UUIDs before checking uniqueness and membership", () => {
    const organizationId = "ABCDEFAB-1234-4234-8234-123456789ABC";
    const candidate = { ...policy.candidate, organizationIds: [organizationId] };
    expect(loadCloudRuntimeConfig({ CLOUD_RUNTIME_BASE_ROLLOUT_JSON: JSON.stringify({ ...policy, candidate }) }))
      .toHaveProperty("baseRollout.candidate.organizationIds", [organizationId.toLowerCase()]);
    expect(() => loadCloudRuntimeConfig({ CLOUD_RUNTIME_BASE_ROLLOUT_JSON: JSON.stringify({ ...policy,
      candidate: { ...candidate, organizationIds: [organizationId, organizationId.toLowerCase()] },
    }) })).toThrow(/CLOUD_RUNTIME_BASE_ROLLOUT_JSON/);
  });

  it.each([
    "", " ", "null", "[]", "{", JSON.stringify({ ...policy, version: 2 }),
    JSON.stringify({ defaultBaseImageId: policy.defaultBaseImageId, candidate: policy.candidate }),
    JSON.stringify({ version: 1, defaultBaseImageId: policy.defaultBaseImageId }),
    JSON.stringify({ ...policy, defaultBaseImageId: "" }),
    JSON.stringify({ ...policy, defaultBaseImageId: "../another-base" }),
    JSON.stringify({ ...policy, defaultBaseImageId: "a".repeat(129) }),
    JSON.stringify({ ...policy, candidate: { ...policy.candidate, baseImageId: policy.defaultBaseImageId } }),
    JSON.stringify({ ...policy, candidate: { ...policy.candidate, organizationIds: [fixture, fixture] } }),
    JSON.stringify({ ...policy, candidate: { ...policy.candidate, organizationIds: ["not-an-org"] } }),
    JSON.stringify({ ...policy, candidate: { ...policy.candidate, organizationIds:
      Array.from({ length: 17 }, (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`) } }),
    JSON.stringify({ ...policy, candidate: { ...policy.candidate, extra: true } }),
    JSON.stringify({ ...policy, extra: true }),
    `${" ".repeat(4096)}${JSON.stringify(policy)}`,
  ])("rejects malformed, partial or oversized policy without echoing its contents (%#)", value => {
    expect(() => loadCloudRuntimeConfig({ CLOUD_RUNTIME_BASE_ROLLOUT_JSON: value })).toThrow(/CLOUD_RUNTIME_BASE_ROLLOUT_JSON/);
  });

  it("does not expose supplied JSON in a parse error", () => {
    const privateValue = "untrusted-operator-input-sentinel";
    let message = "";
    try { loadCloudRuntimeConfig({ CLOUD_RUNTIME_BASE_ROLLOUT_JSON: `{${privateValue}` }); }
    catch (error) { message = String(error); }
    expect(message).toContain("CLOUD_RUNTIME_BASE_ROLLOUT_JSON");
    expect(message).not.toContain(privateValue);
  });
});
