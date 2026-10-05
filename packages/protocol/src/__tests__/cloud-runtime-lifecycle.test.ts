import { describe, expect, it } from "vitest";
import { CloudRuntimeUpgradeRequestSchema, CloudRuntimeUpgradeResponseSchema } from "../cloud-runtime-lifecycle";
import { CloudRuntimeUpgradeRequestSchema as BackendRequest } from "../../../../apps/control-plane/src/cloud-workspaces/runtime-upgrade-contract";

const operationId = "A1111111-1111-4111-8111-111111111111";
describe("cloud runtime upgrade HTTP contract", () => {
  it("keeps the client and independently deployed backend request parsers aligned", () => {
    const input = { operationId, expectedGeneration: 3 };
    expect(BackendRequest.parse(input)).toEqual(CloudRuntimeUpgradeRequestSchema.parse(input));
    expect(CloudRuntimeUpgradeRequestSchema.parse(input).operationId).toBe(operationId.toLowerCase());
    for (const invalid of [{}, { ...input, expectedGeneration: 0 }, { ...input, expectedGeneration: 1.5 },
      { ...input, expectedGeneration: Number.MAX_SAFE_INTEGER + 1 }, { ...input, operationId: "arbitrary" },
      { ...input, runtimeId: "caller-selected" }, { ...input, baseImageId: "caller-selected" }]) {
      expect(BackendRequest.safeParse(invalid).success).toBe(false);
      expect(CloudRuntimeUpgradeRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it("accepts immutable upgrade and no-op receipts without provider or artifact authority", () => {
    const receipt = { operationId: operationId.toLowerCase(), sourceGeneration: 3, generation: 4,
      runtimeId: `r1-${"a".repeat(64)}`, transitionId: operationId.toLowerCase(), unchanged: false };
    expect(CloudRuntimeUpgradeResponseSchema.parse(receipt)).toEqual(receipt);
    expect(CloudRuntimeUpgradeResponseSchema.safeParse({ ...receipt, generation: 3, transitionId: null, unchanged: true }).success).toBe(true);
    expect(CloudRuntimeUpgradeResponseSchema.safeParse({ ...receipt, artifact: { url: "https://artifact.example.test" } }).success).toBe(false);
  });
});
