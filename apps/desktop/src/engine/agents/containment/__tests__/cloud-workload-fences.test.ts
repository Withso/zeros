import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { CloudOwnedWorkloadRegistry } from "../cloud-owned-workloads";
import { HostExecutionBoundary } from "../host-boundary";
import type { PreparedBoundary } from "../types";

const registry = () => new CloudOwnedWorkloadRegistry();
const cleanup: { workloads: CloudOwnedWorkloadRegistry; prepared: PreparedBoundary }[] = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f.workloads.drain(f.workloads.fence()); });
async function setup() {
  const workloads = registry(), host = new HostExecutionBoundary();
  const prepared = await workloads.prepare(host, { executionId: randomUUID(), actor: "agent-code", cwd: process.cwd(), workspaceRoot: process.cwd() },
    undefined, { kind: "terminal", role: "workload", terminalIdle: () => true });
  cleanup.push({ workloads, prepared }); return { workloads, prepared };
}
const input = () => ({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), env: {} });
async function launchReady(prepared: PreparedBoundary) {
  const child = await prepared.spawn({ ...input(), args: ["-e", "console.log('HOST_READY');setInterval(()=>{},1000)"] });
  const marker = await new Promise<string>(resolve => child.stdout!.once("data", value => resolve(value.toString())));
  expect(marker.trim()).toBe("HOST_READY");
  return child;
}
describe("original preserved-owner admission tickets (real Host groups, no native cgroup claim)", () => {
  it("joins pending admissions without killing the preserved original group", async () => {
    const f = await setup(), child = await launchReady(f.prepared);
    const ticket = f.workloads.fence({ preserveActive: true });
    expect(() => f.prepared.wrapSpawn(input())).toThrow();
    await f.workloads.joinPending(ticket);
    expect((await f.workloads.inspect()).workloadPids).toContain(child.pid);
    f.workloads.resume(ticket);
    expect(() => f.workloads.assertAccepting()).not.toThrow();
  });
  it("cancels an unstarted original wrapper before acknowledging the admission fence", async () => {
    const f = await setup(), descriptor = f.prepared.wrapSpawn(input());
    const ticket = f.workloads.fence({ preserveActive: true });
    expect(() => f.workloads.resume(ticket)).toThrow();
    await f.workloads.joinPending(ticket);
    expect(f.workloads.snapshot().pendingLaunches).toBe(0);
    const child = spawn(descriptor.command, descriptor.args, { cwd: descriptor.cwd, env: descriptor.env, detached: true, stdio: "ignore" });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    expect(code).toBe(125);
    f.workloads.resume(ticket);
  });
  it("releases only its own preserved ticket while a VM seal still fences launches", async () => {
    const f = await setup();
    const handoff = f.workloads.fence({ preserveActive: true });
    await f.workloads.joinPending(handoff);
    const seal = f.workloads.fence();
    f.workloads.resume(handoff);
    expect(() => f.workloads.assertAccepting()).toThrow();
    expect(() => f.workloads.resume({ ...seal })).toThrow();
    await f.workloads.drain(seal); f.workloads.resume(seal);
    expect(() => f.workloads.assertAccepting()).not.toThrow();
  });
  it("cannot reinterpret an ordinary drain ticket as a preserved handoff", async () => {
    const f = await setup(), ticket = f.workloads.fence();
    await expect(f.workloads.joinPending(ticket)).rejects.toThrow();
    expect(() => f.workloads.resume(ticket)).toThrow();
    await f.workloads.drain(ticket); f.workloads.resume(ticket);
  });
  it("keeps default Local Host drain separate from the resident-only group receipt", async () => {
    const f = await setup(), child = await launchReady(f.prepared), ticket = f.workloads.fence();
    expect(() => f.workloads.resumeOwned(ticket)).toThrow();
    await expect(f.workloads.drainOwned({ ...ticket })).rejects.toThrow();
    await expect(f.workloads.drainOwned(ticket)).rejects.toThrow();
    await f.workloads.drain(ticket);
    expect(f.workloads.snapshot()).toMatchObject({ complete: true, pendingLaunches: 0, failedRetirements: 0, scopes: [] });
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(() => f.workloads.resumeOwned(ticket)).toThrow();
    f.workloads.resume(ticket);
    expect(() => f.workloads.assertAccepting()).not.toThrow();
  });
});
