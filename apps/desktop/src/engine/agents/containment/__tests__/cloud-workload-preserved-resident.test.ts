import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudOwnedWorkloadRegistry } from "@/engine/agents/containment/cloud-owned-workloads";
import { createCloudWorkloadCustody } from "@/engine/agents/containment/cloud-workload-custody";
import { nativeCloudWorkloadIO, type CloudWorkloadKernelProcess } from "@/engine/agents/containment/cloud-workload-cgroup.mjs";
import { cloudWorkloadKernelFixture, common, engine, resident, workload, identity, kernelProcess } from "@/engine/agents/containment/__tests__/helpers/cloud-workload-kernel";
import { ResidentPtyHost } from "@/engine/pty/resident-host";
import { ResidentPtyClient } from "@/engine/pty/resident-client";
import { ResidentTerminalService } from "@/engine/pty/resident-service";
import type { ResidentEngineAuthority } from "@/engine/pty/resident-protocol";

// Genuine original custody/registry/Host/transport objects. Only deployment
// admission and kernel cgroup IO are explicit portable fixtures, not VM proof.
const configuration = vi.hoisted(() => ({ version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: 10003, gid: 10003,
  toolchain: { node: process.execPath,
    supervisor: process.cwd() + "/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs" } }));
vi.mock("@/engine/agents/containment/cloud-worker-config", () => ({
  isCloudWorkerConfiguration: (value: unknown) => value === configuration,
}));
vi.mock("@/engine/agents/containment/cloud-runtime-root.mjs", async original => ({ ...await original<object>(),
  resolveCloudRuntime: () => ({ cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" }),
}));
const successor = common + "/engine-33333333-3333-4333-8333-333333333333";
const authority = { organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  engineId: "33333333-3333-4333-8333-333333333333", generation: 2, fence: 2 };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
function controllerIO(f: ReturnType<typeof cloudWorkloadKernelFixture>, pid: number) {
  const originalProjection = JSON.stringify(f.projection);
  return { ...f.io, identity: () => ({ pid, uid: 10003, gid: 10003, euid: 10003, egid: 10003 }),
    projection: () => originalProjection };
}
function replaceEngine(f: ReturnType<typeof cloudWorkloadKernelFixture>) {
  f.groups.delete(engine); f.processes.delete(101);
  f.groups.set(successor, { identity: identity("6"), pids: [103] });
  f.processes.set(103, kernelProcess(103, successor));
  f.projection.infrastructure[0] = { kind: "engine", pid: 103, startToken: "1030" };
}
function pair() {
  const kernel = cloudWorkloadKernelFixture();
  const residentCustody = createCloudWorkloadCustody(configuration, { io: controllerIO(kernel, 102) });
  const residentRegistry = new CloudOwnedWorkloadRegistry({ custody: residentCustody });
  return { kernel, residentCustody, residentRegistry };
}
function engineRegistry(f: ReturnType<typeof pair>, pid: number) {
  const custody = createCloudWorkloadCustody(configuration, { io: controllerIO(f.kernel, pid) });
  const registry = new CloudOwnedWorkloadRegistry({ custody });
  registry.registerOwner({ authority, owner: f.residentCustody.controller,
    assertLive: () => f.residentCustody.assertLive(),
    classifyWorkloads: async request => f.residentRegistry.classifyWorkloads(request, authority) });
  return { custody, registry };
}

describe("preserved resident across a root-projected successor (explicit fake kernel IO)", () => {
  it("matches two original controllers on their initial tree and retains an unknown sibling as work", async () => {
    const f = pair(), current = engineRegistry(f, 101);
    expect(current.custody.inspect().censusSha256).toBe(f.residentCustody.inspect().censusSha256);
    expect(await current.registry.inspect()).toMatchObject({ complete: true, workloadPids: [] });
    const sibling = common + "/unregistered-job";
    f.kernel.groups.set(sibling, { identity: identity("7"), pids: [401] });
    f.kernel.processes.set(401, kernelProcess(401, sibling));
    expect(await current.registry.inspect()).toMatchObject({ complete: true, workloadPids: [401] });
  });

  it("uses the same census identity after engine replacement without reminting the preserved resident", async () => {
    const f = pair(); replaceEngine(f.kernel);
    const current = engineRegistry(f, 103);
    const requested = current.custody.inspect(), observed = f.residentCustody.inspect();
    expect(requested.complete).toBe(true); expect(observed.complete).toBe(true);
    expect(requested.processes).toEqual(observed.processes);
    expect.soft(requested.censusSha256).toBe(observed.censusSha256);
    expect.soft(await current.registry.inspect()).toMatchObject({ complete: true, workloadPids: [] });
  });
});

describe.runIf(process.platform === "linux")("actual preserved resident Host and authenticated successor service", () => {
  it("classifies its original quiet shell after the successor attaches using the same kernel census", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "astra-preserved-census-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const kernel = cloudWorkloadKernelFixture(), birth = nativeCloudWorkloadIO.process(process.pid)!;
    kernel.projection.infrastructure[1] = { kind: "resident", pid: process.pid, startToken: birth.startToken };
    kernel.groups.get(resident)!.pids = [process.pid]; kernel.processes.delete(102);
    kernel.processes.set(process.pid, { ...birth, directory: resident, uid: 10003 });
    const residentIO = controllerIO(kernel, process.pid);
    const residentCustody = createCloudWorkloadCustody(configuration, { io: residentIO });
    const firstAuthority: ResidentEngineAuthority = { ...authority, engineId: randomUUID(), generation: 1,
      fence: 1, token: randomBytes(32).toString("base64url") };
    const socketPath = path.join(root, "host.sock");
    const host = new ResidentPtyHost({ root, socketPath, organizationId: authority.organizationId,
      workspaceId: authority.workspaceId, shell: "/bin/bash",
      identity: { uid: process.getuid!(), gid: process.getgid!() }, custody: residentCustody });
    cleanups.push(() => host.stop());

    // Observe actual original Host groups and process births, projecting only
    // their cgroup membership and UID in this explicit fake kernel port.
    const read = kernel.io.read;
    const refresh = (directory: string, name: string) => {
      if (directory === common && name === "cgroup.procs") {
        const roots = new Set(host["workloads"].snapshot().scopes.flatMap(scope => scope.processGroups));
        const all = readdirSync("/proc").filter(value => /^[1-9]\d*$/.test(value))
          .map(value => nativeCloudWorkloadIO.process(Number(value)))
          .filter((value): value is CloudWorkloadKernelProcess => value !== null)
          .filter(value => !["Z", "X"].includes(value.state));
        const selected = new Set(all.filter(member => roots.has(member.group)).map(member => member.pid));
        for (let index = 0; index < all.length; index++) {
          const count = selected.size;
          for (const member of all) if (selected.has(member.parent)) selected.add(member.pid);
          if (count === selected.size) break;
        }
        for (const pid of kernel.groups.get(workload)!.pids) kernel.processes.delete(pid);
        const members = all.filter(member => selected.has(member.pid));
        kernel.groups.get(workload)!.pids = members.map(member => member.pid);
        for (const member of members) kernel.processes.set(member.pid, { ...member, uid: 10003, directory: workload });
        const current = nativeCloudWorkloadIO.process(process.pid)!;
        kernel.processes.set(process.pid, { ...current, uid: 10003, directory: resident });
      }
      return read(directory, name);
    };
    kernel.io.read = refresh; residentIO.read = refresh;
    await host.start(); host.authorize(firstAuthority);
    const first = new ResidentPtyClient({ socketPath, authority: firstAuthority });
    cleanups.push(async () => first.disconnect()); await first.connect();
    await first.create({ sessionId: "preserved-shell", cwd: root, cols: 80, rows: 24,
      env: { PATH: "/usr/bin:/bin", HOME: root } });
    const residentRequest = () => {
      const census = residentCustody.inspect();
      return { version: 1 as const, requestId: randomUUID(), censusSha256: census.censusSha256!, common: census.common };
    };
    await expect.poll(async () => (await first.classifyWorkloads(residentRequest())).quietTerminals.length).toBe(1);
    const originalShell = (await first.classifyWorkloads(residentRequest())).quietTerminals[0]!;
    first.disconnect();
    replaceEngine(kernel);
    const successorCustody = createCloudWorkloadCustody(configuration, { io: controllerIO(kernel, 103) });
    const secondAuthority: ResidentEngineAuthority = { ...authority, token: randomBytes(32).toString("base64url") };
    host.authorize(secondAuthority);
    const service = new ResidentTerminalService({ hostId: resident.slice(resident.lastIndexOf("engine-workload-") + 16),
      socketPath, authority: secondAuthority });
    cleanups.push(async () => service.disconnect()); await service.connect();
    const next = new CloudOwnedWorkloadRegistry({ custody: successorCustody });
    next.registerOwner(service.workloadOwner(successorCustody));
    const census = successorCustody.inspect();
    const reply = await service.classifyWorkloads({ version: 1, requestId: randomUUID(),
      censusSha256: census.censusSha256!, common: census.common });
    expect.soft(reply).toMatchObject({ complete: true, owner: {
      pid: residentCustody.controller.pid, startToken: residentCustody.controller.startToken },
      quietTerminals: [originalShell] });
    expect.soft(await next.inspect()).toMatchObject({ complete: true, workloadPids: [],
      quietTerminalPids: [originalShell.supervisor.pid, originalShell.shell.pid].sort((a, b) => a - b) });
    // The preserved owner still has its original controller publication. It
    // may drain only its own groups; the successor owns aggregate quiescence.
    const ownerTicket = host["workloads"].fence();
    await host["workloads"].drainOwned(ownerTicket);
    expect(residentCustody.inspect().workloadPids).toContain(103);
    await expect(host["workloads"].drain(ownerTicket)).rejects.toThrow();
    await expect.poll(() => next.inspect()).toMatchObject({ complete: true, workloadPids: [], quietTerminalPids: [] });
    const aggregateTicket = next.fence(); await next.drain(aggregateTicket);
    host["workloads"].resumeOwned(ownerTicket);
    expect(() => host["workloads"].assertAccepting()).not.toThrow();
    // Cleanup by the original authenticated owner; no census PID signaling.
    await service.close("preserved-shell");
    kernel.groups.delete(successor); kernel.processes.delete(103);
  });
});
