import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CloudRuntimeHandoffRequestSchema as engine } from "../../apps/desktop/src/engine/cloud-runtime-quiet-state";
import { CloudRuntimeHandoffRequestSchema as server, CloudResidentWitnessSchema,
  CloudRuntimeHandoffReceiptSchema } from "../../apps/control-plane/src/cloud-workspaces/runtime-handoff-contract";
import { CloudResidentWorkload } from "../cloud-workspace-validation/sandbox/cloud-resident-workload.mjs";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";

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
      scope: `/sys/fs/cgroup/system.slice/zeros-host.service/engine-workload-${id}`, fence: 1, engineId: id, generation: 1 };
    expect(CloudResidentWitnessSchema.safeParse(resident).success).toBe(true);
    for (const change of [{ scope: "/sys/fs/cgroup" }, { scope: `/sys/fs/cgroup/system.slice/zeros-host.service/workload-${id}` },
      { scope: `${resident.scope}/nested` }, { engineId: null }, { generation: null }, { token: "rejected" },
      { runtimeId: `r1-${"2".repeat(64)}` }]) expect(CloudResidentWitnessSchema.safeParse({ ...resident, ...change }).success).toBe(false);
  });
  it.each(["server", "adapter"])("accepts the actual root resident descriptor in the %s parser", async parser => {
    const tree = cloudRuntimeFixture();
    try {
      const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
      const host = new CloudResidentWorkload({ runtime, hostId: id, organizationId: id, workspaceId: id });
      vi.spyOn(host, "request").mockResolvedValue(undefined);
      await host.enroll({ organizationId: id, workspaceId: id, engineId: id, generation: 1,
        fence: 1, token: "test-only-resident-grant" });
      // Produce the descriptor through the resident host's scope constructor and authority
      // transitions, so a hand-authored witness cannot hide boundary drift.
      for (const resident of [host.descriptor(), await host.detach({ hostId: id, engineId: id, fence: 1 })]) {
        if (parser === "server") {
          expect(CloudResidentWitnessSchema.safeParse(resident).success).toBe(true);
        } else {
          const result = spawnSync("python3", ["-I", "-c", [
            "import json, runpy, sys",
            "suite = runpy.run_path(sys.argv[1])",
            "suite['update'].resident_document(suite['b'], json.load(sys.stdin))",
          ].join("\n"), path.resolve(import.meta.dirname, "../cloud-workspace-validation/runtime-update/tests/test_update.py")], {
            input: JSON.stringify(resident), encoding: "utf8", timeout: 5000, maxBuffer: 4096,
          });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          expect(result.stdout).toBe("");
          expect(result.stderr).toBe("");
        }
      }
    } finally { tree.dispose(); }
  });
});
