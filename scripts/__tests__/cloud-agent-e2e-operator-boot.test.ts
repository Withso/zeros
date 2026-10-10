import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { configureFixtureMeasurement, createMeasurementReadyGate } from "../cloud-workspace-validation/cloud-agent-e2e/operator-boot";
const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
  bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
const binding = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", authorityEpoch: 1,
  cacheRevision: 1, desiredCacheRevision: 1, initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) };
function fixture() {
  return { actor: { userId: scope.fundingOwnerUserId }, configureBootOwner: vi.fn(), activeBootScope: () => scope,
    inspect: () => ({ boot: { negotiated: true, activated: true } }) };
}
describe("explicit after operator wiring", () => {
  it("configures synthetic owner consent only for the explicitly selected mode before registration", () => {
    const f = fixture(); configureFixtureMeasurement(f, "current"); configureFixtureMeasurement(f, "none");
    expect(f.configureBootOwner).not.toHaveBeenCalled(); configureFixtureMeasurement(f, "boot-owner");
    expect(f.configureBootOwner).toHaveBeenCalledExactlyOnceWith({ fundingOwnerUserId: scope.fundingOwnerUserId, fundingOwnerEpoch: 1,
      actorFundingGrant: { kind: "owner" } });
  });
  it("retains only the exact actually received validated ready fields for the after runner", () => {
    const gate = createMeasurementReadyGate(fixture(), "boot-owner");
    expect(() => gate.ready()).toThrow("fixture_contract_invalid");
    expect(gate.verify({ type: "ENGINE_READY", source: "engine", capabilities: ["cloud.localCommands.v1", "cloud.turnTimings.v1"],
      cloudLocalCommands: binding, unrelated: "private-sentinel" })).toBe(true);
    expect(gate.ready()).toEqual({ type: "ENGINE_READY", source: "engine", capabilities: ["cloud.localCommands.v1", "cloud.turnTimings.v1"], cloudLocalCommands: binding });
    expect(JSON.stringify(gate.ready())).not.toContain("private-sentinel");
  });
  it.each(["missing-ack", "inactive", "foreign-writer", "secret-binding"])("refuses %s and clears an earlier ready instead of falling back", kind => {
    const f = fixture(), gate = createMeasurementReadyGate(f, "boot-owner"), ready = { type: "ENGINE_READY", source: "engine",
      capabilities: ["cloud.localCommands.v1", "cloud.turnTimings.v1"], cloudLocalCommands: binding };
    expect(gate.verify(ready)).toBe(true);
    if (kind === "missing-ack") f.inspect = () => ({ boot: { negotiated: false, activated: true } });
    if (kind === "inactive") f.inspect = () => ({ boot: { negotiated: true, activated: false } });
    if (kind === "foreign-writer") ready.cloudLocalCommands = { ...binding, writerEpoch: randomUUID() };
    if (kind === "secret-binding") Object.assign(ready.cloudLocalCommands = { ...binding }, { apiKey: "private-sentinel" });
    expect(gate.verify(ready)).toBe(false); expect(() => gate.ready()).toThrow("fixture_contract_invalid");
  });
});
