import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { portableCloudWorkloads } from "./helpers/portable-cloud-custody";
import { nativeCloudWorkloadIO } from "../cloud-workload-cgroup.mjs";
import type { CloudOwnedWorkloadRegistry } from "../cloud-owned-workloads";

const fixture = vi.hoisted(() => ({
  deniedPid: null as number | null,
  deniedStatPid: null as number | null,
  exitedPid: null as number | null,
  exitedStat: "",
  configuration: { version: 4 as const, backend: "cloud-worker" as const, profile: "zeros-cloud-worker-v4" as const,
    uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
    toolchain: { node: process.execPath, supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } },
}));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    if (String(args[0]) === `/proc/${fixture.deniedPid}/cgroup`)
      throw Object.assign(new Error("synthetic unrelated process cgroup unavailable"), { code: "EACCES" });
    return actual.openSync(...args);
  }, readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
    const entries = actual.readdirSync(...args);
    // Model the directory inventory captured just before this real child exited.
    return String(args[0]) === "/proc" && fixture.exitedPid !== null
      ? [...entries, String(fixture.exitedPid)] : entries;
  }, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (String(args[0]) === `/proc/${fixture.deniedStatPid}/stat`)
      throw Object.assign(new Error("synthetic original birth unavailable"), { code: "EACCES" });
    if (String(args[0]) === `/proc/${fixture.exitedPid}/stat`) return fixture.exitedStat;
    return actual.readFileSync(...args);
  } };
});
vi.mock("../cloud-worker-config", async original => ({ ...await original<typeof import("../cloud-worker-config")>(),
  isCloudWorkerConfiguration: (value: unknown) => value === fixture.configuration }));
vi.mock("../cloud-runtime-root.mjs", async original => ({ ...await original<typeof import("../cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../__tests__/helpers/test-cloud-runtime")).testCloudRuntime }));

const children: ChildProcess[] = [], registries: CloudOwnedWorkloadRegistry[] = [];
afterEach(async () => {
  fixture.deniedPid = null; fixture.deniedStatPid = null; fixture.exitedPid = null; fixture.exitedStat = "";
  try {
    for (const registry of registries.splice(0)) await registry.drain(registry.fence());
  } finally {
    for (const child of children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL"); await exited;
    }
  }
});
async function unrelatedProcess() {
  const child = spawn("/bin/sleep", ["60"], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  return child.pid!;
}
function workloads() {
  const registry = portableCloudWorkloads(fixture.configuration); registries.push(registry); return registry;
}

describe.runIf(process.platform === "linux")("portable custody uses real births and explicit fake cgroups", () => {
  it("does not let an unrelated host cgroup refusal break fixture construction", async () => {
    fixture.deniedPid = await unrelatedProcess();
    // Production's native reader still refuses this condition. Only the
    // explicitly fake cgroup fixture must be independent of ambient groups.
    expect(() => nativeCloudWorkloadIO.process(fixture.deniedPid!)).toThrow("Cloud workload custody is not ready");
    expect(await workloads().inspect()).toMatchObject({ complete: true, workloadPids: [] });
  });

  it("keeps an already empty fixture drain proven when an unrelated cgroup becomes unreadable", async () => {
    const pid = await unrelatedProcess(), registry = workloads();
    fixture.deniedPid = pid;
    await expect(registry.drain(registry.fence())).resolves.toBeUndefined();
    expect(await registry.inspect()).toMatchObject({ complete: true, workloadPids: [] });
  });

  it("still refuses empty proof when the actual controller birth cannot be read", async () => {
    const registry = workloads(); fixture.deniedStatPid = process.pid;
    expect(await registry.inspect()).toMatchObject({ complete: false });
    await expect(registry.drain(registry.fence())).rejects.toThrow("cloud workload drain is not positively empty");
  });

  it("excludes a kernel-dead task whose process-group identity was cleared during exit", async () => {
    const pid = await unrelatedProcess(), child = children.at(-1)!;
    const source = readFileSync(`/proc/${pid}/stat`, "utf8"), end = source.lastIndexOf(")");
    const fields = source.slice(end + 1).trim().split(/\s+/);
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await exited;
    // Captured under real SIGKILL churn: X, parent 0, group/session -1,
    // tty 0 and foreground -1. The immutable original birth remains present.
    fields.splice(0, 6, "X", "0", "-1", "-1", "0", "-1");
    fixture.exitedPid = pid; fixture.exitedStat = `${source.slice(0, end + 1)} ${fields.join(" ")}\n`;
    const registry = workloads();
    expect(await registry.inspect()).toMatchObject({ complete: true, workloadPids: [] });
    await expect(registry.drain(registry.fence())).resolves.toBeUndefined();
  });

  it("still refuses malformed live process identity instead of treating it as an exit", async () => {
    const pid = await unrelatedProcess(), source = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = source.lastIndexOf(")"), fields = source.slice(end + 1).trim().split(/\s+/);
    const registry = workloads();
    fields.splice(0, 6, "S", "0", "-1", "-1", "0", "-1");
    fixture.exitedPid = pid; fixture.exitedStat = `${source.slice(0, end + 1)} ${fields.join(" ")}\n`;
    expect(await registry.inspect()).toMatchObject({ complete: false });
    await expect(registry.drain(registry.fence())).rejects.toThrow("cloud workload drain is not positively empty");
  });
});
