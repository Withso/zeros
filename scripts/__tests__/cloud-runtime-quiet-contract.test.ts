import { describe, expect, it } from "vitest";
import { CloudRuntimeQuietSnapshotSchema as engine } from "../../packages/protocol/src/cloud-runtime-lifecycle";
import { CloudRuntimeQuietSnapshotSchema as server } from "../../apps/control-plane/src/cloud-workspaces/runtime-quiet-contract";

const id = "11111111-1111-4111-8111-111111111111";
const valid = { version: 1, challenge: id, workspaceId: id, organizationId: id, generation: 1, engineInstanceId: id,
  activityRevision: 0, quietForMs: 60_000, stable: true, recordSync: "ready", workloadBusy: false,
  livePty: false, userProcesses: "idle", presence: "absent" };
describe("cloud runtime quiet snapshot contract parity", () => {
  it("keeps standalone control-plane and engine parsing identical", () => {
    const variants: unknown[] = [valid, null, {}, { ...valid, privateData: "rejected" }];
    for (const key of Object.keys(valid)) {
      const missing = { ...valid } as Record<string, unknown>; delete missing[key]; variants.push(missing);
      for (const value of [null, -1, Number.MAX_SAFE_INTEGER + 1, 0.5, "invalid", false, {}, []]) variants.push({ ...valid, [key]: value });
    }
    for (const presence of ["present", "absent", "unknown"]) variants.push({ ...valid, presence });
    for (const userProcesses of ["idle", "busy", "unknown"]) variants.push({ ...valid, userProcesses });
    for (const candidate of variants) {
      const left = engine.safeParse(candidate), right = server.safeParse(candidate);
      expect(left.success).toBe(right.success);
      if (left.success && right.success) expect(left.data).toEqual(right.data);
    }
    expect(engine.safeParse(valid).success).toBe(true);
    expect(server.safeParse({ ...valid, privateData: "rejected" }).success).toBe(false);
  });
});
