import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import { CloudWorkerSupervisor, parseCloudWorkerSupervisorRequest, CLOUD_WORKER_SUPERVISOR_AUDIENCE }
  from "../cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs";
import { CloudResidentWorkload } from "../cloud-workspace-validation/sandbox/cloud-resident-workload.mjs";

function fixture() {
  const tree = cloudRuntimeFixture();
  const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
  const hostId = randomUUID(), organizationId = randomUUID(), workspaceId = randomUUID();
  const sourceId = randomUUID();
  let witness: {hostId:string; organizationId:string; workspaceId:string; engineId:string|null; generation:number; fence:number}
    = { hostId, organizationId, workspaceId, engineId: sourceId, generation: 1, fence: 1 };
  const descriptor = () => ({ ...witness, protocol: "zeros.resident-pty/v1", runtimeId: runtime.runtimeId,
    manifestSha256: runtime.manifestSha256, bootId: runtime.bootId, supervisorSessionId: runtime.supervisorSessionId,
    scope: `${runtime.cgroupRoot}/engine-runtime/engine-workload-${hostId}` });
  const resident = {
    identity: { hostId, organizationId, workspaceId },
    descriptor,
    witness: vi.fn(async () => descriptor()),
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    detach: vi.fn(async expected => {
      if (expected.hostId !== hostId || expected.engineId !== witness.engineId || expected.fence !== witness.fence)
        throw new Error("Resident authority rejected");
      witness = { ...witness, engineId: null, fence: witness.fence + 1 };
      return descriptor();
    }),
    enroll: vi.fn(async value => { witness = { ...witness, engineId: value.engineId, generation: value.generation, fence: value.fence }; }),
  };
  const retire = vi.fn(async () => {});
  const requestEngineHandoff = vi.fn(async (_endpoint, command) => ({ version: 1, ...command, accepted: true,
    ...(command.action === "prepare" ? { receipt: { version: 1, ...command.request, phase: "fenced", activityRevision: 9 } } : {}) }));
  const supervisor = new CloudWorkerSupervisor({ runtime, engineScope: { retire },
    verifySelectedRuntime: value => value, createResident: async () => resident, requestEngineHandoff });
  supervisor.resident = resident;
  const launch = vi.spyOn(supervisor, "launch").mockResolvedValue(12345);
  const environment = (engineId = randomUUID(), generation = 2) => ({
    port: 43001,
    runtime: { execution: { organizationId, workspaceId, generation }, engine: { instanceId: engineId, readinessProbeToken: `zwr_${"R".repeat(43)}` } },
    runtimeB64: "synthetic",
  });
  const startSource = async () => {
    const prepared = await supervisor.apply({ operation: "prepare" });
    await supervisor.apply({ operation: "start", session: prepared.session, environment: environment(sourceId, 1), resident: { hostId, fence: 1 } });
    retire.mockClear(); resident.stop.mockClear(); resident.detach.mockClear(); launch.mockClear();
  };
  const handoff = { workspaceId, organizationId, generation: 1, engineInstanceId: sourceId, hostId, fence: 1,
    challenge: randomUUID(), expiresAtMs: Date.now() + 30_000 };
  return { tree, supervisor, resident, retire, launch, hostId, sourceId, organizationId, workspaceId, environment,
    startSource, handoff, requestEngineHandoff };
}

describe("resident supervisor attach fencing", () => {
  it("validates the root handoff request without accepting arbitrary destinations or proof fields", () => {
    const f = fixture();
    try {
      const request = { version: 1, audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
        operation: "runtime-handoff", action: "prepare", handoff: f.handoff };
      expect(parseCloudWorkerSupervisorRequest(request)).toEqual(request);
      for (const fields of [{ action: "consume" }, { destination: "http://other.test" }, { handoff: { ...f.handoff, fence: 0 } }])
        expect(parseCloudWorkerSupervisorRequest({ ...request, ...fields })).toBeNull();
    } finally { f.tree.dispose(); }
  });

  it("consumes a sealed source receipt before detaching and reuses the existing one-use prepared session", async () => {
    const f = fixture();
    try {
      await f.startSource();
      const source = { hostId: f.hostId, engineId: f.sourceId, fence: 1 };
      expect(await f.supervisor.apply({ operation: "prepare", resident: source, handoff: f.handoff })).toMatchObject({ outcome: "rejected" });
      expect(await f.supervisor.apply({ operation: "runtime-handoff", action: "prepare", handoff: f.handoff }))
        .toMatchObject({ outcome: "fenced", handoff: { activityRevision: 9, ...f.handoff } });
      expect(f.retire).not.toHaveBeenCalled();
      const prepared = await f.supervisor.apply({ operation: "prepare", resident: source, handoff: f.handoff });
      expect(prepared).toMatchObject({ outcome: "prepared", resident: { hostId: f.hostId, fence: 2 } });
      expect(f.requestEngineHandoff.mock.calls.map(call => call[1].action)).toEqual(["prepare", "consume"]);
      expect(f.resident.detach).toHaveBeenCalledOnce(); expect(f.resident.stop).not.toHaveBeenCalled();
      expect(f.retire).toHaveBeenCalledWith({ preserveWorkload: f.hostId });
      // A lost response cannot require killing the surviving workload to get a
      // new session. Replay is bound to the same receipt while it is unspent.
      expect(await f.supervisor.apply({ operation: "prepare", resident: source, handoff: f.handoff })).toEqual(prepared);
      expect(f.resident.detach).toHaveBeenCalledOnce();
      // A preserved source receipt cannot be stripped or replaced on retry.
      await expect(f.supervisor.apply({ operation: "prepare", resident: source })).rejects.toThrow(/authority/);
      expect(await f.supervisor.apply({ operation: "prepare", resident: source,
        handoff: { ...f.handoff, challenge: randomUUID() } })).toMatchObject({ outcome: "rejected" });
      expect(await f.supervisor.apply({ operation: "prepare", resident: source, handoff: f.handoff })).toEqual(prepared);
    } finally { f.tree.dispose(); }
  });

  it("never retires a draining, cancelled, stale or unconsumable source", async () => {
    const f = fixture();
    try {
      await f.startSource();
      const request = { operation: "runtime-handoff", action: "prepare", handoff: f.handoff };
      const source = { hostId: f.hostId, engineId: f.sourceId, fence: 1 };
      const prepare = { operation: "prepare", resident: source, handoff: f.handoff };
      const reply = f.requestEngineHandoff.getMockImplementation()!;
      f.requestEngineHandoff.mockImplementationOnce(async (endpoint, command) => {
        const result = await reply(endpoint, command); return { ...result, receipt: { ...result.receipt, phase: "draining" } };
      });
      expect(await f.supervisor.apply(request)).toMatchObject({ outcome: "draining" });
      expect(await f.supervisor.apply(prepare)).toMatchObject({ outcome: "rejected" });
      await f.supervisor.apply(request);
      f.requestEngineHandoff.mockImplementationOnce(async (_endpoint, command) => ({ version: 1, ...command, accepted: false }));
      expect(await f.supervisor.apply(prepare)).toMatchObject({ outcome: "rejected" });
      expect(await f.supervisor.apply({ ...request, handoff: { ...f.handoff, generation: 2 } })).toMatchObject({ outcome: "rejected" });
      expect(await f.supervisor.apply({ ...request, action: "cancel" })).toMatchObject({ outcome: "cancelled" });
      expect(await f.supervisor.apply(prepare)).toMatchObject({ outcome: "rejected" });
      expect(f.retire).not.toHaveBeenCalled(); expect(f.resident.detach).not.toHaveBeenCalled();
    } finally { f.tree.dispose(); }
  });
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

  it("replays a lost rollback prepare reply without detaching the failed target twice", async () => {
    const f = fixture();
    try {
      const request = { operation: "prepare", resident: { hostId: f.hostId, engineId: f.sourceId, fence: 1 } };
      const prepared = await f.supervisor.apply(request);
      expect(await f.supervisor.apply(request)).toEqual(prepared);
      expect(f.resident.detach).toHaveBeenCalledOnce();
      expect(f.retire).toHaveBeenCalledOnce();
      expect(f.resident.stop).not.toHaveBeenCalled();
      for (const changed of [{ engineId: randomUUID() }, { hostId: randomUUID() }, { fence: 2 }])
        await expect(f.supervisor.apply({ ...request, resident: { ...request.resident, ...changed } })).rejects.toThrow(/authority/);
      expect(await f.supervisor.apply({ ...request, handoff: f.handoff })).toMatchObject({ outcome: "rejected" });
      // Only the exact same request can recover the unspent session.
      expect(await f.supervisor.apply(request)).toEqual(prepared);
      expect(await f.supervisor.apply({ operation: "start", session: prepared.session,
        environment: f.environment(), resident: { hostId: f.hostId, fence: 3 } })).toMatchObject({ outcome: "started" });
      await expect(f.supervisor.apply(request)).rejects.toThrow(/authority/);
      expect(f.launch).toHaveBeenCalledOnce();
    } finally { f.tree.dispose(); }
  });

  it("retains the actual resident descriptor and detached authority on rollback prepare replay", async () => {
    const f = fixture();
    try {
      const host = new CloudResidentWorkload({ runtime: f.supervisor.runtime,
        hostId: f.hostId, organizationId: f.organizationId, workspaceId: f.workspaceId });
      // Only kernel/IPC effects are substituted; descriptor, enroll, detach
      // and supervisor requests use the real production implementations.
      host.request = vi.fn(async () => ({}));
      // Substitute only the root's kernel readback. Public descriptors carry
      // no original controller PID, inode or private record authority.
      vi.spyOn(host, "rootCustody").mockReturnValue({ version: 1 });
      await host.enroll({ organizationId: f.organizationId, workspaceId: f.workspaceId,
        generation: 2, engineId: f.sourceId, fence: 3, token: "synthetic" });
      f.supervisor.resident = host;
      const request = { operation: "prepare", resident: { hostId: f.hostId, engineId: f.sourceId, fence: 3 } };
      const prepared = await f.supervisor.apply(request);
      expect(prepared.resident).toMatchObject({ engineId: null, generation: null, fence: 4,
        scope: `${f.supervisor.runtime.cgroupRoot}/engine-runtime/engine-workload-${f.hostId}` });
      expect(await f.supervisor.apply(request)).toEqual(prepared);
      expect(await host.witness()).toEqual(prepared.resident);
      expect(f.retire).toHaveBeenCalledExactlyOnceWith({ preserveWorkload: f.hostId });
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
