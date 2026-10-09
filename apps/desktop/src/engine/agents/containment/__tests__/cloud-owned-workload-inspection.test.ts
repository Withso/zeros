import { portableCloudWorkloads } from "./helpers/portable-cloud-custody";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudExecutionBoundary } from "../cloud-execution-boundary";
import { CloudOwnedWorkloadRegistry } from "../cloud-owned-workloads";

const state = vi.hoisted(() => ({ tty: false, background: false, shellGroup: false }));
const configuration = vi.hoisted(() => ({ uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
  version: 4 as const, backend: "cloud-worker" as const, profile: "zeros-cloud-worker-v4" as const,
  toolchain: { node: process.execPath, supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } }));
vi.mock("../cloud-worker-config", () => ({ isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
vi.mock("../cloud-runtime-root.mjs", async original => ({ ...await original<typeof import("../cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../__tests__/helpers/test-cloud-runtime")).testCloudRuntime }));

const registries: CloudOwnedWorkloadRegistry[] = [];
afterEach(async () => {
  state.tty = state.background = state.shellGroup = false;
  for (const registry of registries.splice(0)) await registry.drain(registry.fence());
});
function setup() {
  const workloads = portableCloudWorkloads(configuration, { projectProcess: (member, members) => {
    if (!state.tty) return member;
    const root = members.find(value => value.pid === member.session);
    const shell = root && members.find(value => value.parent === root.pid);
    const foreground = state.background ? -1 : state.shellGroup && shell ? shell.pid : member.group;
    return { ...member, tty: 42, foreground,
      group: state.shellGroup && root && member.pid !== root.pid ? member.pid : member.group };
  } }); registries.push(workloads);
  return { workloads, boundary: new CloudExecutionBoundary({ configuration, workloads }) };
}
const request = () => ({ executionId: randomUUID(), actor: "repo-code-task" as const, cwd: process.cwd(), workspaceRoot: process.cwd() });
const launch = () => ({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), env: {} });

describe("original cloud workload kernel inventory", () => {
  it.each([false, true])("allows only the original idle supervisor and direct foreground shell to be quiet (shell job group=%s)", async (shellGroup) => {
    const { boundary, workloads } = setup(); state.tty = true; state.shellGroup = shellGroup;
    const prepared = await boundary.prepareOwned(request(), { kind: "terminal", role: "workload", terminalIdle: () => true });
    const child = await prepared.spawn({ ...launch(), args: ["-e", "console.log('ready');setInterval(()=>{},1000)"] });
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    expect(await workloads.inspect()).toMatchObject({ complete: true, workloadPids: [], pendingLaunches: 0 });
    await prepared.stopAndProve();
  });
  it.each(["recent-input", "no-tty", "not-foreground", "async-result"] as const)("counts a terminal as work when %s prevents its idle proof", async (condition) => {
    const { boundary, workloads } = setup(); state.tty = condition !== "no-tty"; state.background = condition === "not-foreground";
    const terminalIdle = condition === "async-result" ? () => Promise.resolve(true) : () => condition !== "recent-input";
    const prepared = await boundary.prepareOwned(request(), { kind: "terminal", role: "workload", terminalIdle });
    const child = await prepared.spawn(launch());
    await expect.poll(() => workloads.inspect(), { timeout: 3000 }).toMatchObject({
      complete: true, workloadPids: expect.arrayContaining([child.pid]),
    });
    await prepared.stopAndProve();
  });
  it.each(["exec", "builtin"] as const)("counts a foreground %s command at the original shell PID and start token", async kind => {
    const { boundary, workloads } = setup(); state.tty = true;
    const prepared = await boundary.prepareOwned(request(), { kind: "terminal", role: "workload", terminalIdle: () => true });
    const child = await prepared.spawn({ command: "/bin/bash", args: ["--noprofile", "--norc", "-c", `printf 'ready\\n'; read -r value; ${kind === "exec" ? "exec /usr/bin/sleep 60" : "while :; do :; done"}`],
      cwd: process.cwd(), env: {} });
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    expect(await workloads.inspect()).toMatchObject({ complete: true, workloadPids: [] });
    child.stdin!.write("go\n");
    await expect.poll(async () => (await workloads.inspect()).workloadPids, { timeout: 1000 }).toContain(child.pid);
    await prepared.stopAndProve();
  });
  it("does not grant terminal idle exemptions to provider or infrastructure scopes", async () => {
    const { boundary } = setup();
    await expect(boundary.prepareOwned(request(), { kind: "agent", role: "workload", terminalIdle: () => true })).rejects.toThrow();
    await expect(boundary.prepareOwned(request(), { kind: "language-service", role: "infrastructure", terminalIdle: () => true })).rejects.toThrow();
  });
  it("counts an original descendant in a shell job group and retains it after Host group retirement", async () => {
    const { boundary, workloads } = setup(); state.tty = true;
    const prepared = await boundary.prepareOwned(request(), { kind: "terminal", role: "workload", terminalIdle: () => true });
    const child = await prepared.spawn({ ...launch(), args: ["-e",
      "const c=require('node:child_process').spawn('/usr/bin/python3',['-c','import os,time; os.setpgid(0,0); print(os.getpid(),flush=True); time.sleep(1.2)'],{stdio:['ignore','pipe','inherit']});c.stdout.pipe(process.stdout);setInterval(()=>{},1000)" ] });
    const jobPid = await new Promise<number>((resolve) => child.stdout!.once("data", (value) => resolve(Number(value.toString().trim()))));
    expect((await workloads.inspect()).workloadPids).toContain(jobPid);
    await expect(prepared.stopAndProve()).resolves.toBeUndefined(); // exact Host group proof only
    expect(workloads.snapshot().failedRetirements).toBe(0);
    expect((await workloads.inspect()).workloadPids).toContain(jobPid);
    await expect.poll(async () => (await workloads.inspect()).workloadPids, { timeout: 3000 }).toEqual([]);
    expect(await workloads.inspect()).toMatchObject({ complete: true, workloadPids: [] });
  });
});
