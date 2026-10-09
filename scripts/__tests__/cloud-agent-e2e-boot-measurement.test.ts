import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudAgentBootConversationSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { requireBootMeasurementBinding } from "../cloud-workspace-validation/cloud-agent-e2e/boot-measurement";

function fixture() {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const binding = CloudAgentBootConversationSchema.parse({ ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
    authorityEpoch: 1, cacheRevision: 1, desiredCacheRevision: 1,
    initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) });
  return { scope, binding, ready: { type: "ENGINE_READY", source: "engine", capabilities: ["cloud.localCommands.v1", "cloud.turnTimings.v1"], cloudLocalCommands: binding },
    authority: { negotiated: true, activated: true, scope, authorityEpoch: 1 } };
}
describe("actual READY plus independent CP negotiation guard", () => {
  it("retains only strict shared nonsecret binding after all actual metadata agrees", () => {
    const f = fixture();
    expect(requireBootMeasurementBinding(f.ready, f.authority)).toEqual(f.binding);
  });
  it.each(["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch"] as const)("refuses foreign %s before CONNECTED/Send", field => {
      const f = fixture(), binding = { ...f.binding, [field]: typeof f.binding[field] === "number" ? 2 : randomUUID() };
      expect(() => requireBootMeasurementBinding({ ...f.ready, cloudLocalCommands: binding }, f.authority)).toThrow("fixture_contract_invalid");
    });
  it.each(["ack", "activation", "capability", "metadata", "authority", "secret", "frame"])("never manufactures missing %s", kind => {
    const f = fixture();
    if (kind === "ack") f.authority.negotiated = false;
    if (kind === "activation") f.authority.activated = false;
    if (kind === "capability") f.ready.capabilities = ["cloud.turnTimings.v1"];
    const ready = kind === "metadata" ? { ...f.ready, cloudLocalCommands: undefined }
      : kind === "authority" ? { ...f.ready, cloudLocalCommands: { ...f.binding, authorityEpoch: 2 } }
        : kind === "secret" ? { ...f.ready, cloudLocalCommands: { ...f.binding, token: "fixture-private-sentinel" } }
          : kind === "frame" ? { ...f.ready, source: "browser" } : f.ready;
    expect(() => requireBootMeasurementBinding(ready, f.authority)).toThrow("fixture_contract_invalid");
  });
});
