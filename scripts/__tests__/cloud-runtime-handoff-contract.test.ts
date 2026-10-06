import { describe, expect, it } from "vitest";
import { CloudRuntimeHandoffRequestSchema as engine } from "../../apps/desktop/src/engine/cloud-runtime-quiet-state";
import { CloudRuntimeHandoffRequestSchema as server, CloudResidentWitnessSchema,
  CloudRuntimeHandoffReceiptSchema } from "../../apps/control-plane/src/cloud-workspaces/runtime-handoff-contract";

const id = "11111111-1111-4111-8111-111111111111";
const valid = { challenge: id, workspaceId: id, organizationId: id, generation: 1, engineInstanceId: id,
  hostId: id, fence: 1, expiresAtMs: 1_800_000_000_000 };
describe("cloud runtime handoff contract parity", () => {
  it("keeps the standalone server parser identical to the engine request parser", () => {
    const variants: unknown[] = [valid, null, {}, { ...valid, privateData: "rejected" }];
    for (const key of Object.keys(valid)) {
      const missing = { ...valid } as Record<string, unknown>; delete missing[key]; variants.push(missing);
      for (const value of [null, -1, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 0.5, "invalid", false, {}, []])
        variants.push({ ...valid, [key]: value });
    }
    for (const value of variants) {
      const left = engine.safeParse(value), right = server.safeParse(value);
      expect(left.success).toBe(right.success);
      if (left.success && right.success) expect(left.data).toEqual(right.data);
    }
    expect(server.safeParse(valid).success).toBe(true);
  });
  it("requires a fenced receipt and an exact resident cgroup without extra credential fields", () => {
    const receipt = { ...valid, version: 1, phase: "fenced", activityRevision: 0 };
    expect(CloudRuntimeHandoffReceiptSchema.safeParse(receipt).success).toBe(true);
    for (const change of [{ phase: "draining" }, { activityRevision: -1 }, { session: "rejected" }])
      expect(CloudRuntimeHandoffReceiptSchema.safeParse({ ...receipt, ...change }).success).toBe(false);
    const resident = { hostId: id, organizationId: id, workspaceId: id, protocol: "zeros.resident-pty/v1",
      runtimeId: `r1-${"1".repeat(64)}`, manifestSha256: "1".repeat(64), bootId: id, supervisorSessionId: id,
      scope: `/sys/fs/cgroup/system.slice/zeros-host.service/workload-${id}`, fence: 1, engineId: id, generation: 1 };
    expect(CloudResidentWitnessSchema.safeParse(resident).success).toBe(true);
    for (const change of [{ scope: "/sys/fs/cgroup" }, { engineId: null }, { generation: null }, { token: "rejected" },
      { runtimeId: `r1-${"2".repeat(64)}` }]) expect(CloudResidentWitnessSchema.safeParse({ ...resident, ...change }).success).toBe(false);
  });
});
