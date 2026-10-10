import { ChildProcess, spawnSync } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CloudRuntimeHandoffRequestSchema as engine } from "../../apps/desktop/src/engine/cloud-runtime-quiet-state";
import { CloudRuntimeHandoffRequestSchema as server, CloudResidentWitnessSchema,
  CloudRuntimeHandoffReceiptSchema } from "../../apps/control-plane/src/cloud-workspaces/runtime-handoff-contract";
import { CloudResidentWorkload } from "../cloud-workspace-validation/sandbox/cloud-resident-workload.mjs";
import { CloudEngineCgroup } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { CloudWorkerSupervisor } from "../cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";

const id = "11111111-1111-4111-8111-111111111111";
const valid = { challenge: id, workspaceId: id, organizationId: id, generation: 1, engineInstanceId: id,
  hostId: id, fence: 1, expiresAtMs: 1_800_000_000_000 };

function assertResidentParsed(parser: string, resident: unknown) {
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
      { scope: `${resident.scope}/nested` },
      { engineId: null }, { generation: null }, { token: "rejected" },
      { runtimeId: `r1-${"2".repeat(64)}` }]) expect(CloudResidentWitnessSchema.safeParse({ ...resident, ...change }).success).toBe(false);
  });
  it.each(["server", "adapter"])("accepts the actual archived dedicated resident descriptor in the %s parser", async parser => {
    const tree = cloudRuntimeFixture();
    try {
      const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
      const host = new CloudResidentWorkload({ runtime, hostId: id, organizationId: id, workspaceId: id });
      // Frozen handoff readers accept the ORIGINAL archived dedicated leaf.
      // A modern shared-pool controller cannot stand in for that legacy owner.
      expect(host.scope.directory).toBe(`${runtime.cgroupRoot}/engine-runtime/engine-workload-${id}`);
      host.scope = new CloudEngineCgroup({ runtime, directory: `${runtime.cgroupRoot}/engine-workload-${id}` });
      vi.spyOn(host, "request").mockResolvedValue(undefined);
      await host.enroll({ organizationId: id, workspaceId: id, engineId: id, generation: 1,
        fence: 1, token: "test-only-resident-grant" });
      // Produce the descriptor through the resident host's scope constructor and authority
      // transitions, so a hand-authored witness cannot hide boundary drift.
      for (const resident of [host.descriptor(), await host.detach({ hostId: id, engineId: id, fence: 1 })]) {
        expect(resident.scope).toBe(host.scope.directory);
        assertResidentParsed(parser, resident);
      }
    } finally { tree.dispose(); }
  });

  it.each(["server", "adapter"])("accepts the CURRENT root witness and supervisor resident-status in the %s parser", async parser => {
    const tree = cloudRuntimeFixture();
    const owner = { pid: 12346, startToken: "123460" };
    const child = Object.assign(new ChildProcess(), { pid: owner.pid, exitCode: null,
      signalCode: null, stdin: new PassThrough(), stdout: new PassThrough() });
    try {
      const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
      const scope = { directory: `${runtime.cgroupRoot}/engine-runtime/engine-workload-${id}`, dev: "0", ino: "23" };
      const common = `${runtime.cgroupRoot}/engine-runtime`;
      const original = { version: 1, episode: id,
        runtime: { runtimeId: runtime.runtimeId, bootId: runtime.bootId, supervisorSessionId: runtime.supervisorSessionId },
        owner, scope, common: { directory: common, dev: "0", ino: "21" },
        workload: { directory: `${common}/engine-workload-shared/workload`, dev: "0", ino: "22" },
        birth: { kind: "resident", pid: 23456, startToken: "234560" } };
      const readCustody = vi.fn(() => structuredClone(original));
      const host = new CloudResidentWorkload({ runtime, hostId: id, organizationId: id, workspaceId: id,
        spawnProcess: () => child, readBirth: () => ({ ...owner, parentPid: process.pid }), readCustody });
      // Only kernel/process/IPC observations are substituted. The current
      // default scope, original root custody checks and emitted wire stay real.
      host.scope.io = { identity: vi.fn(() => ({ ...scope })) };
      vi.spyOn(host, "request").mockResolvedValue(undefined);
      await host.start("synthetic-runtime-identity");
      await host.enroll({ organizationId: id, workspaceId: id, engineId: id, generation: 1,
        fence: 1, token: "test-only-resident-grant" });
      expect(host.scope.directory).toBe(scope.directory);
      expect(host.rootCustody()).toEqual(original);
      const witness = await host.witness();
      const supervisor = new CloudWorkerSupervisor({ runtime });
      supervisor.resident = host;
      const status = await supervisor.apply({ operation: "resident-status" });
      expect(status).toMatchObject({ outcome: "ready", resident: witness });
      const detached = await host.detach({ hostId: id, engineId: id, fence: 1 });
      for (const resident of [witness, status.resident, detached]) {
        expect(resident.scope).toBe(host.scope.directory);
        assertResidentParsed(parser, resident);
      }
      expect(readCustody).toHaveBeenCalledWith({ runtime, owner, scope, episode: id });
      readCustody.mockReturnValue({ ...structuredClone(original), birth: { ...original.birth, startToken: "changed" } });
      await expect(supervisor.apply({ operation: "resident-status" })).rejects.toThrow(/custody changed/);
    } finally { child.stdin.destroy(); child.stdout.destroy(); tree.dispose(); }
  });
});
