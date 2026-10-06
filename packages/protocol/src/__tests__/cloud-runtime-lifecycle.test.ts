import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseBridgeMessage } from "../schemas";
import { CloudRuntimeUpgradeAvailabilitySchema, CloudRuntimeUpgradeRequestSchema, CloudRuntimeUpgradeResponseSchema } from "../cloud-runtime-lifecycle";
import { CloudRuntimeUpgradeAvailabilitySchema as BackendAvailability, CloudRuntimeUpgradeRequestSchema as BackendRequest } from "../../../../apps/control-plane/src/cloud-workspaces/runtime-upgrade-contract";

const operationId = "A1111111-1111-4111-8111-111111111111";
describe("cloud runtime upgrade HTTP contract", () => {
  it("keeps existing local bridge messages and package entrypoints unchanged", () => {
    for (const message of [
      { id: "local-workspaces", timestamp: 0, source: "browser", type: "WORKSPACE_REQUEST", op: "list" },
      { id: "local-terminal", timestamp: 0, source: "browser", type: "PTY_WRITE", sessionId: "local-terminal", data: "fixture" },
    ]) expect(JSON.parse(JSON.stringify(parseBridgeMessage(message)))).toEqual(message);
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(manifest.exports).toMatchObject({ ".": "./src/index.ts", "./messages": "./src/messages.ts",
      "./schemas": "./src/schemas.ts", "./containment": "./src/containment.ts" });
  });
  it("aligns read-only availability and progress without exposing provider or artifact authority", () => {
    const currentRuntimeId = `r1-${"a".repeat(64)}`, latestRuntimeId = `r1-${"b".repeat(64)}`;
    const input = { organizationId: operationId.toLowerCase(), workspaceId: operationId.toLowerCase(), generation: 3,
      currentRuntimeId, latestRuntimeId, updateAvailable: true, unavailableReason: null,
      transition: { id: operationId.toLowerCase(), generation: 4, runtimeId: latestRuntimeId, state: "draining", error: null } };
    for (const value of [input, { ...input, currentRuntimeId: null, latestRuntimeId: null, updateAvailable: false,
      unavailableReason: "cloud_runtime_upgrade_not_supported", transition: null }])
      expect(BackendAvailability.parse(value)).toEqual(CloudRuntimeUpgradeAvailabilitySchema.parse(value));
    for (const invalid of [{ ...input, generation: 0 }, { ...input, latestRuntimeId: "arbitrary" },
      { ...input, unavailableReason: "unknown" }, { ...input, artifactUrl: "https://example.test/private" },
      { ...input, transition: { ...input.transition, state: "unknown" } }]) {
      expect(BackendAvailability.safeParse(invalid).success).toBe(false);
      expect(CloudRuntimeUpgradeAvailabilitySchema.safeParse(invalid).success).toBe(false);
    }
  });
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
