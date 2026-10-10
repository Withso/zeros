import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostExecutionBoundary } from "../host-boundary";
import * as custodyModule from "../cloud-workload-custody";
import { cloudWorkloadKernelFixture } from "./helpers/cloud-workload-kernel";
import type { PreparedBoundary } from "../types";

const configuration = vi.hoisted(() => ({ version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: 10003, gid: 10003,
  toolchain: { node: process.execPath, supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } }));
vi.mock("../cloud-worker-config", () => ({ isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
vi.mock("../cloud-runtime-root.mjs", async original => ({ ...await original<object>(),
  resolveCloudRuntime: () => ({ cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" }),
}));
const cleanup: PreparedBoundary[] = [];
afterEach(async () => { for (const boundary of cleanup.splice(0)) await boundary.stopAndProve(); vi.restoreAllMocks(); });
async function prepared(cloud: boolean) {
  const kernel = cloudWorkloadKernelFixture(), custody = custodyModule.createCloudWorkloadCustody(configuration, { io: kernel.io });
  vi.spyOn(custodyModule, "cloudWorkloadHostEntry").mockReturnValue(custody.entry);
  const host = new HostExecutionBoundary(cloud ? { cloudWorkloadCustody: custody } : {});
  const result = await host.prepare({ executionId: randomUUID(), actor: "agent-code", cwd: process.cwd(), workspaceRoot: process.cwd() });
  cleanup.push(result); return { boundary: result, custody, kernel };
}
const input = () => ({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd: process.cwd(),
  env: { PATH: "/selected/bin", HOME: "/selected/home", NODE_OPTIONS: "--require=/untrusted/module.cjs",
    LD_PRELOAD: "/untrusted/interposer.so", ZEROS_HOST_SUPERVISOR_WORKLOAD_ENTRY: "caller-courier",
    ZEROS_TEST: "selected" } });

describe("cloud-only Host entry producer, Local unchanged", () => {
  it("keeps selected target env out of the supervisor startup and binds original custody", async () => {
    const f = await prepared(true), launch = f.boundary.wrapSpawn(input());
    expect(launch.args).toContain("--cloud-workload");
    expect(launch.env.NODE_OPTIONS).toBeUndefined(); expect(launch.env.LD_PRELOAD).toBeUndefined();
    expect(launch.env.HOME).toBeUndefined(); expect(launch.env.ZEROS_TEST).toBeUndefined();
    const entry = JSON.parse(Buffer.from(launch.env.ZEROS_HOST_SUPERVISOR_WORKLOAD_ENTRY!, "base64url").toString());
    expect(entry).toEqual(f.custody.entry);
    expect(JSON.parse(Buffer.from(launch.env.ZEROS_HOST_SUPERVISOR_ORIGINAL_ENV!, "base64url").toString()))
      .toEqual(input().env);
    f.boundary.cancelUnstartedLaunch!(launch);
  });
  it("rechecks exact controller authority at the original launch handoff", async () => {
    const f = await prepared(true); f.kernel.processes.set(101, { ...f.kernel.processes.get(101)!, startToken: "999" });
    expect(() => f.boundary.wrapSpawn(input())).toThrow();
  });
  it("Local preserves the existing selected env and reserved-prefix envelope byte shape", async () => {
    const f = await prepared(false), launch = f.boundary.wrapSpawn(input());
    expect(launch.args).not.toContain("--cloud-workload");
    expect(launch.env.NODE_OPTIONS).toBe(input().env.NODE_OPTIONS); expect(launch.env.LD_PRELOAD).toBe(input().env.LD_PRELOAD);
    expect(launch.env.HOME).toBe(input().env.HOME);
    expect(JSON.parse(Buffer.from(launch.env.ZEROS_HOST_SUPERVISOR_ORIGINAL_ENV!, "base64url").toString()))
      .toEqual({ ZEROS_HOST_SUPERVISOR_WORKLOAD_ENTRY: "caller-courier" });
    f.boundary.cancelUnstartedLaunch!(launch);
  });
});
