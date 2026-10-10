import { describe, expect, it, vi } from "vitest";
import { createCloudWorkloadCustody, isCloudWorkloadCustody, cloudWorkloadHostEntry, cloudWorkloadCustodyConfiguration } from "../cloud-workload-custody";
import { cloudWorkloadKernelFixture, engine, workload } from "./helpers/cloud-workload-kernel";

const configuration = vi.hoisted(() => ({ version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: 10003, gid: 10003,
  toolchain: { node: "/opt/zeros/node", supervisor: "/opt/zeros/host-process-supervisor.mjs" } }));
vi.mock("../cloud-worker-config", () => ({ isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
vi.mock("../cloud-runtime-root.mjs", async (original) => ({ ...await original<object>(),
  resolveCloudRuntime: () => ({ cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" }),
}));

describe("original cloud workload custody controller", () => {
  it("requires the original deployment before touching kernel custody", () => {
    const f = cloudWorkloadKernelFixture(), read = vi.spyOn(f.io, "projection");
    expect(() => createCloudWorkloadCustody({ ...configuration }, { io: f.io })).toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("binds one original controller and its immutable root-projected descriptor", () => {
    const f = cloudWorkloadKernelFixture(), custody = createCloudWorkloadCustody(configuration, { io: f.io });
    expect(isCloudWorkloadCustody(custody)).toBe(true);
    expect(isCloudWorkloadCustody({ ...custody })).toBe(false);
    expect(custody.controller).toEqual({ kind: "engine", pid: 101, startToken: "1010" });
    expect(custody.entry.workload.directory).toBe(workload);
    expect(cloudWorkloadCustodyConfiguration(custody)).toBe(configuration);
    expect(Object.isFrozen(custody.entry)).toBe(true);
    expect(() => cloudWorkloadHostEntry({ ...custody } as typeof custody)).toThrow();
  });
  it("keeps explicit fake-kernel fixtures separate from native entry qualification", () => {
    const f = cloudWorkloadKernelFixture(), custody = createCloudWorkloadCustody(configuration, { io: f.io });
    expect(cloudWorkloadHostEntry(custody)).toBeNull();
    expect(custody.inspect()).toMatchObject({ complete: true, workloadPids: [] });
    expect(f.writes).toEqual([]);
  });
  it.each(["birth", "membership", "inode"])("refuses a changed original %s before a launch", condition => {
    const f = cloudWorkloadKernelFixture(), custody = createCloudWorkloadCustody(configuration, { io: f.io });
    if (condition === "birth") f.processes.set(101, { ...f.processes.get(101)!, startToken: "99" });
    if (condition === "membership") f.processes.set(101, { ...f.processes.get(101)!, directory: workload });
    if (condition === "inode") f.groups.get(engine)!.identity.ino = "99";
    expect(() => custody.assertLive()).toThrow();
    expect(custody.inspect().complete).toBe(false);
  });
  it("returns unknown after lost kernel visibility, then recovers on the original identity", () => {
    const f = cloudWorkloadKernelFixture(), custody = createCloudWorkloadCustody(configuration, { io: f.io });
    const read = vi.spyOn(f.io, "read").mockImplementation(() => { throw new Error("unavailable"); });
    expect(custody.inspect()).toMatchObject({ complete: false });
    read.mockRestore();
    expect(custody.inspect()).toMatchObject({ complete: true });
    expect(() => custody.assertLive()).not.toThrow();
  });
  it("keeps launch authority separate from an unrelated incomplete workload census", () => {
    const f = cloudWorkloadKernelFixture(), custody = createCloudWorkloadCustody(configuration, { io: f.io });
    const read = f.io.read;
    f.io.read = (directory, name) => { if (name === "cgroup.procs") throw new Error("workload census changed"); return read(directory, name); };
    expect(custody.inspect().complete).toBe(false);
    expect(() => custody.assertLive()).not.toThrow();
  });
});
