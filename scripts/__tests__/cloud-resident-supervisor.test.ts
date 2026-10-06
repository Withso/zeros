import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import { CloudWorkerSupervisor, parseCloudWorkerSupervisorRequest, CLOUD_WORKER_SUPERVISOR_AUDIENCE }
  from "../cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs";

function fixture() {
  const tree = cloudRuntimeFixture();
  const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
  const hostId = randomUUID(), organizationId = randomUUID(), workspaceId = randomUUID();
  const sourceId = randomUUID();
  let witness = { hostId, organizationId, workspaceId, engineId: sourceId, generation: 1, fence: 1 };
  const resident = {
    identity: { hostId, organizationId, workspaceId },
    descriptor: () => ({ ...witness }),
    witness: vi.fn(async () => ({ ...witness })),
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    detach: vi.fn(async expected => {
      if (expected.hostId !== hostId || expected.engineId !== witness.engineId || expected.fence !== witness.fence)
        throw new Error("Resident authority rejected");
      witness = { ...witness, engineId: null, fence: witness.fence + 1 };
      return { ...witness };
    }),
    enroll: vi.fn(async value => { witness = { ...witness, engineId: value.engineId, generation: value.generation, fence: value.fence }; }),
  };
  const retire = vi.fn(async () => {});
  const supervisor = new CloudWorkerSupervisor({ runtime, engineScope: { retire },
    verifySelectedRuntime: value => value, createResident: () => resident });
  supervisor.resident = resident;
  const launch = vi.spyOn(supervisor, "launch").mockResolvedValue(12345);
  const environment = (engineId = randomUUID(), generation = 2) => ({
    runtime: { execution: { organizationId, workspaceId, generation }, engine: { instanceId: engineId } },
    runtimeB64: "synthetic",
  });
  return { tree, supervisor, resident, retire, launch, hostId, sourceId, organizationId, workspaceId, environment };
}

describe("resident supervisor attach fencing", () => {
  it("extends prepare with an exact source witness and rejects arbitrary preservation fields", () => {
    const request = { audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE, version: 1, operation: "prepare",
      resident: { hostId: randomUUID(), engineId: randomUUID(), fence: 1 } };
    expect(parseCloudWorkerSupervisorRequest(request)).toEqual(request);
    for (const resident of [{ ...request.resident, fence: 0 }, { ...request.resident, scope: "/sys/fs/cgroup/host" },
      { ...request.resident, hostId: "../host" }, { hostId: request.resident.hostId, fence: 1 }])
      expect(parseCloudWorkerSupervisorRequest({ ...request, resident })).toBeNull();
  });

  it("binds preservation and the next attachment to the existing one-use prepared session", async () => {
    const f = fixture();
    try {
      const prepared = await f.supervisor.apply({ operation: "prepare",
        resident: { hostId: f.hostId, engineId: f.sourceId, fence: 1 } });
      expect(prepared).toMatchObject({ outcome: "prepared", resident: { hostId: f.hostId, fence: 2, engineId: null } });
      expect(f.retire).toHaveBeenCalledWith({ preserveWorkload: f.hostId });
      expect(f.resident.stop).not.toHaveBeenCalled();
      const environment = f.environment();
      for (const resident of [undefined, { hostId: randomUUID(), fence: 3 }, { hostId: f.hostId, fence: 2 }])
        expect(await f.supervisor.apply({ operation: "start", session: prepared.session, environment, resident }))
          .toMatchObject({ outcome: "rejected" });
      expect(f.launch).not.toHaveBeenCalled();
      const start = { operation: "start", session: prepared.session, environment, resident: { hostId: f.hostId, fence: 3 } };
      expect(await f.supervisor.apply(start)).toMatchObject({ outcome: "started" });
      expect(f.resident.enroll).toHaveBeenCalledOnce();
      // No token assertion or matcher output: authority remains on private pipes.
      expect(f.resident.enroll.mock.calls[0][0].engineId).toBe(environment.runtime.engine.instanceId);
      expect(await f.supervisor.apply(start)).toMatchObject({ outcome: "rejected" });
      expect(f.launch).toHaveBeenCalledOnce();
    } finally { f.tree.dispose(); }
  });

  it("does not disturb jobs on a stale source witness or attach a different workspace", async () => {
    const f = fixture();
    try {
      await expect(f.supervisor.apply({ operation: "prepare", resident: { hostId: f.hostId, engineId: randomUUID(), fence: 1 } }))
        .rejects.toThrow(/authority/);
      expect(f.retire).not.toHaveBeenCalled(); expect(f.resident.stop).not.toHaveBeenCalled();
      const prepared = await f.supervisor.apply({ operation: "prepare", resident: { hostId: f.hostId, engineId: f.sourceId, fence: 1 } });
      const environment = f.environment(); environment.runtime.execution.workspaceId = randomUUID();
      expect(await f.supervisor.apply({ operation: "start", session: prepared.session,
        resident: { hostId: f.hostId, fence: 3 }, environment })).toMatchObject({ outcome: "rejected" });
      expect(f.launch).not.toHaveBeenCalled(); expect(f.resident.enroll).not.toHaveBeenCalled();
    } finally { f.tree.dispose(); }
  });

  it("keeps ordinary prepare destructive and never preserves an unresponsive host", async () => {
    const f = fixture();
    try {
      f.resident.witness.mockRejectedValueOnce(new Error("unavailable"));
      await expect(f.supervisor.apply({ operation: "prepare", resident: { hostId: f.hostId, engineId: f.sourceId, fence: 1 } }))
        .rejects.toThrow(/unavailable/);
      expect(f.retire).not.toHaveBeenCalled();
      await f.supervisor.apply({ operation: "prepare" });
      expect(f.resident.stop).toHaveBeenCalledOnce();
      expect(f.retire).toHaveBeenCalledWith();
      expect(f.supervisor.resident).toBeNull();
    } finally { f.tree.dispose(); }
  });
});
