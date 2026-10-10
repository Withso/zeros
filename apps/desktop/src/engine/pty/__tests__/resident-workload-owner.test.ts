import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResidentTerminalService } from "../resident-service";
import { createCloudWorkloadCustody } from "../../agents/containment/cloud-workload-custody";
import { CloudOwnedWorkloadRegistry } from "../../agents/containment/cloud-owned-workloads";
import { cloudWorkloadKernelFixture, resident } from "../../agents/containment/__tests__/helpers/cloud-workload-kernel";
import type { ResidentWorkloadClassification, ResidentWorkloadCensusRequest } from "../resident-protocol";

const configuration = vi.hoisted(() => ({ version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: 10003, gid: 10003,
  toolchain: { node: "/opt/zeros/node", supervisor: "/opt/zeros/host-process-supervisor.mjs" } }));
vi.mock("../../agents/containment/cloud-worker-config", () => ({
  isCloudWorkerConfiguration: (value: unknown) => value === configuration,
}));
vi.mock("../../agents/containment/cloud-runtime-root.mjs", async original => ({ ...await original<object>(),
  resolveCloudRuntime: () => ({ cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" }),
}));
afterEach(() => vi.restoreAllMocks());

async function fixture(connected = true, hostId = resident.slice(resident.lastIndexOf("engine-workload-") + 16)) {
  const kernel = cloudWorkloadKernelFixture();
  const custody = createCloudWorkloadCustody(configuration, { io: kernel.io });
  const authority = { organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(),
    generation: 1, fence: 2, token: randomBytes(32).toString("base64url") };
  const service = new ResidentTerminalService({ hostId, socketPath: "/unused", authority });
  const client = service["client"];
  vi.spyOn(client, "connect").mockResolvedValue();
  vi.spyOn(client, "isConnected").mockReturnValue(true);
  vi.spyOn(client, "list").mockResolvedValue([]);
  if (connected) await service.connect();
  const classify = vi.spyOn(client, "classifyWorkloads").mockImplementation(async request => ({
    ...request, authority: { organizationId: authority.organizationId, workspaceId: authority.workspaceId,
      engineId: authority.engineId, generation: authority.generation, fence: authority.fence },
    owner: { pid: 102, startToken: "1020" }, complete: true,
    pendingLaunches: 0, failedRetirements: 0, quietTerminals: [],
  }));
  return { kernel, custody, authority, service, client, classify };
}

describe("resident owner attachment joined to ORIGINAL custody (explicit fake kernel IO)", () => {
  it("captures only the exact root-projected resident birth and original authenticated authority", async () => {
    const f = await fixture(), channel = f.service.workloadOwner(f.custody);
    expect(channel.owner).toEqual({ pid: 102, startToken: "1020" });
    expect(channel.authority).not.toHaveProperty("token");
    expect(Object.isFrozen(channel)).toBe(true);
    const registry = new CloudOwnedWorkloadRegistry({ custody: f.custody });
    registry.registerOwner(channel);
    expect(await registry.inspect()).toMatchObject({ complete: true, workloadPids: [], infrastructurePids: [101, 102] });
    expect(f.classify).toHaveBeenCalledOnce();
    const request = f.classify.mock.calls[0]![0];
    expect(request).toMatchObject({ version: 1, common: f.custody.entry.common });
    expect(request.censusSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a copied custody before requesting any remote classification", async () => {
    const f = await fixture();
    expect(() => f.service.workloadOwner({ ...f.custody })).toThrow();
    expect(f.classify).not.toHaveBeenCalled();
  });

  it("never chooses a different resident birth when the captured host scope is missing", async () => {
    const f = await fixture(true, randomUUID());
    expect(() => f.service.workloadOwner(f.custody)).toThrow("host_unavailable");
    expect(f.classify).not.toHaveBeenCalled();
  });

  it("requires the actual attachment to have finished before installing the owner", async () => {
    const f = await fixture(false);
    expect(() => f.service.workloadOwner(f.custody)).toThrow("host_unavailable");
    expect(f.classify).not.toHaveBeenCalled();
  });

  it("keeps the authority captured at construction immutable", async () => {
    const f = await fixture();
    const initialFence = f.authority.fence;
    f.authority.fence++;
    const channel = f.service.workloadOwner(f.custody);
    expect(channel.authority.fence).toBe(initialFence);
  });

  it("refuses the original channel after disconnect even if a newer attachment reconnects", async () => {
    const f = await fixture(), channel = f.service.workloadOwner(f.custody);
    f.service.disconnect(); await f.service.connect();
    expect(() => channel.assertLive()).toThrow("host_unavailable");
    expect(() => f.service.workloadOwner(f.custody)).not.toThrow();
  });

  it("does not publish a late classification after the original attachment retires", async () => {
    const f = await fixture(), channel = f.service.workloadOwner(f.custody);
    let finish!: (value: ResidentWorkloadClassification) => void;
    let request!: ResidentWorkloadCensusRequest;
    f.classify.mockImplementation(value => { request = value; return new Promise(resolve => { finish = resolve; }); });
    const census = f.custody.inspect();
    const supplied = { version: 1 as const, requestId: randomUUID(), censusSha256: census.censusSha256!, common: census.common };
    const reading = channel.classifyWorkloads(supplied);
    const rejected = expect(reading).rejects.toThrow("host_unavailable");
    f.service.disconnect();
    finish({ ...request, authority: channel.authority, owner: channel.owner,
      complete: true, pendingLaunches: 0, failedRetirements: 0, quietTerminals: [] });
    await rejected;
  });
});
