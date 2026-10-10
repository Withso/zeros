import { expect, it, vi } from "vitest";
import { CloudDelegatedCgroups, CloudEngineCgroup, CloudRuntimeCgroup } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";
import path from "node:path";
const id = "32345678-1234-4234-8234-123456789abc";
function fixture(cpus = "0-3", memory = "MemTotal: 8388608 kB\n", nominalCpuMillicores = 4000) {
  const nominalMemoryMiB = Number(/^MemTotal: ([0-9]+) kB/.exec(memory)?.[1] ?? 8388608) / 1024;
  const runtime = testCloudRuntime(), root = runtime.cgroupRoot;
  const resourceContract = { architecture: "linux/amd64", cpuMillicores: nominalCpuMillicores, memoryMiB: nominalMemoryMiB, storageMiB: 20480 };
  const state = new Map<string, Map<string, string>>([[root, new Map([["cgroup.procs", ""], ["cgroup.controllers", "cpu memory pids"], ["cgroup.subtree_control", "cpu memory pids"]])],
    [`${root}/host`, new Map([["cgroup.events", "populated 1"], ["cgroup.procs", "17"], ["cpu.max", "100000 100000"]])]]);
  const io = {
    exists: vi.fn((file: string) => state.has(file)),
    create: vi.fn((file: string) => { state.set(file, new Map([["cgroup.events", "populated 0"], ["cgroup.procs", ""], ["cgroup.controllers", "cpu memory pids"], ["cgroup.subtree_control", ""]])); }),
    children: vi.fn((file: string) => [...state.keys()].filter(key => key.startsWith(file + "/") && !key.slice(file.length + 1).includes("/")).map(key => key.slice(file.length + 1))),
    read: vi.fn((file: string, name: string) => state.get(file)?.get(name) ?? ""),
    readAbsolute: vi.fn((file: string) => {
      if (file === "/proc/meminfo") return memory;
      if (file === `${root}/cpuset.cpus.effective`) return cpus;
      if (file.endsWith("cpuset.cpus.effective")) throw Object.assign(new Error(), { code: "ENOENT" });
      const value = state.get(path.dirname(file))?.get(path.basename(file));
      if (value === undefined) throw Object.assign(new Error("missing kernel control"), { code: "ENOENT" });
      return value;
    }),
    write: vi.fn((file: string, name: string, value: string) => {
      state.get(file)!.set(name, value.replaceAll("+", ""));
      if (name === "cgroup.kill") for (const [candidate, controls] of state) if (candidate === file || candidate.startsWith(file + "/")) { controls.set("cgroup.events", "populated 0"); controls.set("cgroup.procs", ""); }
    }),
    delegate: vi.fn((_directory: string, _controls: readonly string[]) => {}),
    identity: vi.fn((directory: string) => ({ directory, dev: "0", ino: String([...state.keys()].indexOf(directory) + 100) })),
    processIdentity: vi.fn(() => ({ uid: 10003, gid: 10003 })),
    remove: vi.fn((file: string) => { if (io.children(file).length) throw new Error("not empty"); state.delete(file); }),
  };
  return { runtime, root, state, io, resourceContract };
}
it("preserves main bounds above BOTH branches while engine stays uncapped and the workload is CPU-only", () => {
  const { runtime, root, state, io, resourceContract } = fixture();
  const tree = new CloudRuntimeCgroup({ runtime, io, resourceContract }); tree.prepare();
  const engine = new CloudEngineCgroup({ runtime, io, resourceContract, instanceId: id }); engine.prepare();
  expect(engine.directory).toBe(`${root}/engine-runtime/engine-${id}`);
  expect(Object.fromEntries(state.get(tree.directory)!.entries())).toMatchObject({ "cpu.max": "400000 100000", "memory.max": "7516192768", "pids.max": "4096", "memory.oom.group": "1", "cgroup.subtree_control": "cpu" });
  expect(Object.fromEntries(state.get(engine.directory)!.entries())).toMatchObject({ "cpu.max": "max 100000", "cpu.weight": "100" });
  expect(state.get(engine.directory)!.has("memory.max")).toBe(false);
  expect(Object.fromEntries(state.get(tree.workloadDirectory)!.entries())).toMatchObject({ "cpu.max": "300000 100000", "cpu.weight": "100" });
  expect(state.get(`${tree.directory}/engine-workload-shared`)!.get("cgroup.subtree_control")).toBe("cpu");
  expect(state.get(`${root}/host`)!.get("cpu.max")).toBe("100000 100000");
  expect(state.get(root)!.get("cgroup.subtree_control")).toBe("cpu memory pids");
  expect(tree.cpuSplit).toEqual({ engine: { cpuMax: "max 100000", cpuWeight: 100 }, workload: { controllers: ["cpu"], cpuWeight: 100, cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300000 100000" } } });
});
it.each([["0", 4, "100000 100000", "75000 100000"], ["0-1", 8, "200000 100000", "150000 100000"], ["0-7", 16, "800000 100000", "600000 100000"], ["0-15", 16, "1600000 100000", "1200000 100000"]])("scales genuine common bounds for %s CPUs/%iGiB", (cpus, gib, parent, workload) => {
  const { runtime, state, io, resourceContract } = fixture(cpus, `MemTotal: ${gib * 1024 * 1024} kB\n`, Number(parent.split(" ")[0]) / 100);
  const tree = new CloudRuntimeCgroup({ runtime, io, resourceContract }); tree.prepare();
  expect(state.get(tree.directory)!.get("cpu.max")).toBe(parent);
  expect(state.get(tree.directory)!.get("memory.max")).toBe(String((gib - 1) * 1024 ** 3));
  expect(state.get(tree.workloadDirectory)!.get("cpu.max")).toBe(workload);
});
it("creates mandatory custody when measurements fail, retaining exact main fallback and closed diagnostic", () => {
  const { runtime, state, io } = fixture("invalid", "private");
  const tree = new CloudRuntimeCgroup({ runtime, io }); tree.prepare();
  expect(state.get(tree.directory)!.get("memory.max")).toBe("7516192768");
  expect(state.get(tree.directory)!.get("cpu.max")).toBe("400000 100000");
  expect(state.get(tree.workloadDirectory)!.get("cpu.max")).toBe("max 100000");
  expect(tree.cpuSplit?.workload.cap).toEqual({ kind: "skipped", cpuMax: "max 100000", diagnostic: "cpuset_invalid" });
});
it("reserves memory from the same actual provider allocation, not a protected host sibling", () => {
  const { runtime, root, state, io } = fixture("0-3", "MemTotal: 16777216 kB\n");
  state.get(root)!.set("memory.max", String(8 * 1024 ** 3));
  state.get(`${root}/host`)!.set("memory.max", String(256 * 1024 ** 2));
  const tree = new CloudRuntimeCgroup({ runtime, io }); tree.prepare();
  expect(state.get(tree.directory)!.get("memory.max")).toBe("7516192768");
});
it("caps against a tighter actual upstream quota with the reader's exact rational rounding", () => {
  const { runtime, root, state, io, resourceContract } = fixture("0-7", undefined, 8000);
  state.get(root)!.set("cpu.max", "100001 300000");
  const tree = new CloudRuntimeCgroup({ runtime, io, resourceContract }); tree.prepare();
  expect(state.get(tree.directory)!.get("cpu.max")).toBe("800000 100000");
  expect(state.get(tree.workloadDirectory)!.get("cpu.max")).toBe("25000 100000");
  expect(tree.cpuSplit?.workload.cap).toEqual({ kind: "applied", effectiveCpus: 8, cpuMax: "25000 100000" });
});
it("delegates only same-user directory/migration controls; every quota remains root-owned", () => {
  const { runtime, io } = fixture(); const tree = new CloudRuntimeCgroup({ runtime, io }); tree.prepare();
  for (const [directory, controls] of io.delegate.mock.calls) {
    expect(directory).toMatch(/\/engine-runtime(?:\/|$)/);
    expect(controls).toEqual(["cgroup.procs", "cgroup.threads", "cgroup.subtree_control"]);
  }
  expect(io.delegate).toHaveBeenCalledWith(tree.workloadDirectory, ["cgroup.procs", "cgroup.threads", "cgroup.subtree_control"]);
});
it("never migrates root helpers into the delegated tree", () => {
  const { runtime, io } = fixture(); const scope = new CloudEngineCgroup({ runtime, io, instanceId: id }); scope.prepare();
  io.processIdentity.mockReturnValue({ uid: 0, gid: 0 });
  expect(() => scope.attach(123)).toThrow(/identity/);
  expect(io.write).not.toHaveBeenCalledWith(scope.directory, "cgroup.procs", "123");
  io.processIdentity.mockReturnValue({ uid: 10003, gid: 10003 }); scope.attach(124);
  expect(io.write).toHaveBeenCalledWith(scope.directory, "cgroup.procs", "124");
});
it("pins original control/common/workload inodes before passing a placement or custody projection", () => {
  const { runtime, io } = fixture(); const scope = new CloudEngineCgroup({ runtime, io, instanceId: id }); scope.prepare();
  expect(scope.placement).toBe(`${scope.directory}@0:105`);
  expect(scope.custodySeed()).toEqual({ version: 1,
    common: { directory: `${runtime.cgroupRoot}/engine-runtime`, dev: "0", ino: "102" },
    workload: { directory: `${runtime.cgroupRoot}/engine-runtime/engine-workload-shared/workload`, dev: "0", ino: "104" },
    infrastructure: [], cpuSplit: scope.cpuSplit });
  io.identity.mockImplementation(directory => ({ directory, dev: "0", ino: "999" }));
  expect(() => scope.custodySeed()).toThrow(/identity/);
  expect(() => scope.placement).toThrow(/identity/);
});
it("refuses projection before genuine preparation or for an archived direct scope", () => {
  const { runtime, io } = fixture(); const scope = new CloudEngineCgroup({ runtime, io, instanceId: id });
  expect(() => scope.custodySeed()).toThrow(/identity/);
  expect(() => scope.placement).toThrow(/identity/);
  const legacy = new CloudEngineCgroup({ runtime, io, directory: `${runtime.cgroupRoot}/engine-${id}` }); legacy.prepare();
  expect(() => legacy.custodySeed()).toThrow(/identity/);
});
it("whole-tree outside-root drain kills escaped siblings and prunes arbitrary nested kernel groups before the frozen final verifier", async () => {
  const { runtime, root, state, io } = fixture(); const tree = new CloudRuntimeCgroup({ runtime, io }); tree.prepare();
  for (const suffix of [`engine-${id}`, "own-sibling", "own-sibling/detached"]) io.create(`${tree.directory}/${suffix}`);
  state.get(tree.directory)!.set("cgroup.events", "populated 1");
  state.get(`${tree.directory}/own-sibling/detached`)!.set("cgroup.events", "populated 1");
  await new CloudDelegatedCgroups({ runtime, io }).retire();
  expect(io.write).toHaveBeenCalledWith(tree.directory, "cgroup.kill", "1");
  expect([...state.keys()]).toEqual([root, `${root}/host`]);
  expect(io.write).not.toHaveBeenCalledWith(`${root}/host`, "cgroup.kill", "1");
});
it("unknown or still-populated tree evidence never gives an adoption/drain success", async () => {
  const { runtime, state, io } = fixture(); const tree = new CloudRuntimeCgroup({ runtime, io }); tree.prepare();
  state.get(tree.directory)!.set("cgroup.events", "populated 1");
  expect(() => new CloudDelegatedCgroups({ runtime, io }).assertRetired()).toThrow(/not retired/);
  io.write.mockImplementation(() => {});
  await expect(tree.retire(1)).rejects.toThrow(/unconfirmed/);
  expect(io.remove).not.toHaveBeenCalled();
});
