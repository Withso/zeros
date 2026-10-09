import { beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkloadKernelIO } from "../../apps/desktop/src/engine/agents/containment/cloud-workload-cgroup.mjs";
const root = "/sys/fs/cgroup/system.slice/zeros-host.service", common = `${root}/engine-runtime`;
const engine = `${common}/engine-32345678-1234-4234-8234-123456789abc`, shared = `${common}/engine-workload-shared`, workload = `${shared}/workload`;
const ports = vi.hoisted(() => ({ load: vi.fn(), budget: vi.fn() }));
vi.mock("../../apps/desktop/src/engine/agents/containment/cloud-workload-cgroup.mjs", () => ({ loadCloudWorkloadCustody: ports.load, nativeCloudWorkloadIO: {} }));
vi.mock("../cloud-workspace-validation/sandbox/cloud-resource-budget.mjs", () => ({ readCloudResourceBudgetProjection: ports.budget }));
import { qualifyCloudEngineResources } from "../cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs";
const split = () => ({ engine: { cpuMax: "max 100000", cpuWeight: 100 }, workload: { controllers: ["cpu"], cpuWeight: 100,
  cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300000 100000" } } });
let files: Record<string, string>, evidence: ReturnType<typeof descriptor>;
function descriptor() { return { common: { directory: common, dev: "1", ino: "2" }, workload: { directory: workload, dev: "1", ino: "3" },
  infrastructure: [{ kind: "engine", pid: 22, startToken: "123", controlDirectory: engine }], cpuSplit: split() }; }
const unused = (): never => { throw new Error("unexpected fake kernel operation"); };
const io: CloudWorkloadKernelIO = { identity: () => ({ pid: 22, uid: 10003, gid: 10003, euid: 10003, egid: 10003 }),
  directory: (directory: string) => ({ uid: 10003, mode: 0o755, filesystem: 0x63677270,
  dev: "1", ino: directory === common ? "2" : "3" }), control: () => ({ uid: 65534, mode: 0o444, filesystem: 0x63677270, dev: "1", ino: "4" }),
  read: (directory: string, name: string) => { const value = files[`${directory}/${name}`]; if (value === undefined) throw new Error("fixture missing"); return value; },
  projection: unused, children: unused, process: unused, writeSelf: unused };
beforeEach(() => {
  files = { "/proc/self/cgroup": `0::${engine.slice("/sys/fs/cgroup".length)}\n`, [`${common}/cpu.max`]: "400000 100000",
    [`${common}/memory.max`]: String(7 * 1024 ** 3), [`${common}/pids.max`]: "4096", [`${common}/cgroup.subtree_control`]: "cpu",
    [`${shared}/cgroup.subtree_control`]: "cpu", [`${engine}/cpu.max`]: "max 100000", [`${engine}/cpu.weight`]: "100",
    [`${workload}/cpu.max`]: "300000 100000", [`${workload}/cpu.weight`]: "100",
    [`${root}/host/memory.max`]: String(256 * 1024 ** 2), "/proc/meminfo": `MemTotal: ${8 * 1024 ** 2} kB\n` };
  evidence = descriptor(); ports.load.mockReset().mockReturnValue(evidence);
  ports.budget.mockReset().mockReturnValue({ version: 1,
    resources: { architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 40960 },
    memoryBudget: { nominalMemoryBytes: String(8 * 1024 ** 3), measuredMemoryBytes: String(8 * 1024 ** 3),
      hostMemoryMax: String(256 * 1024 ** 2), source: "nominal", capped: false } });
});
const qualify = () => qualifyCloudEngineResources({ cgroupRoot: root }, io, (file: string) => files[file] ?? null);
it("joins the original controller birth, actual ancestor limits and verified CPU split", () => {
  const result = qualify(); expect(result).toMatchObject({ finite: true, cpuMax: "400000 100000", memoryMax: String(7 * 1024 ** 3), pidsMax: "4096", cpuSplit: split() });
  expect(ports.load).toHaveBeenCalledExactlyOnceWith(root, io);
  expect(result.memoryBudget).toEqual(ports.budget.mock.results[0].value.memoryBudget);
  expect(ports.budget).toHaveBeenCalledOnce();
});
it.each(["cpu.max", "cpu.weight"])("rejects changed engine %s", name => {
  files[`${engine}/${name}`] = name === "cpu.max" ? "400000 100000" : "99"; expect(qualify).toThrow();
});
it.each(["cpu.max", "cpu.weight"])("rejects changed workload %s", name => {
  files[`${workload}/${name}`] = name === "cpu.max" ? "299999 100000" : "99"; expect(qualify).toThrow();
});
it("refuses an engine outside its original controller control leaf", () => {
  files["/proc/self/cgroup"] = `0::${workload.slice("/sys/fs/cgroup".length)}\n`; expect(qualify).toThrow();
});
it("rejects replaced common inode and lost required parent memory", () => {
  evidence.common.ino = "4"; expect(qualify).toThrow(); evidence = descriptor(); ports.load.mockReturnValue(evidence);
  delete files[`${common}/memory.max`]; expect(qualify).toThrow();
});
it("refuses changed controller set instead of declaring cpu-only from metadata", () => {
  files[`${shared}/cgroup.subtree_control`] = "cpu memory"; expect(qualify).toThrow();
});
it("refuses unlimited CPU against the original nominal SKU", () => {
  files[`${common}/cpu.max`] = "max 100000"; expect(qualify).toThrow();
});
it("refuses unknown or contradictory cap diagnostics", () => {
  Object.assign(evidence.cpuSplit.workload, { cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: "private error" } }); expect(qualify).toThrow();
});
it("rejects a changed actual host reserve instead of trusting projection text", () => {
  files[`${root}/host/memory.max`] = String(1024 ** 3); expect(qualify).toThrow();
});
it("rejects a changed MemTotal against the original raw budget measurement", () => {
  files["/proc/meminfo"] = "MemTotal: 8131788 kB\n"; expect(qualify).toThrow();
});
it("refuses a replaced or malformed root resource document", () => {
  ports.budget.mockImplementation(() => { throw new Error("private fixture refusal"); }); expect(qualify).toThrow();
});
it("refuses a root nominal that no longer matches its actual admitted resource contract", () => {
  const value = ports.budget.getMockImplementation()!();
  value.resources.memoryMiB = 16384; expect(qualify).toThrow();
});
it("keeps exact uncapped main fallback with genuine raw RAM below the nominal host ceiling", () => {
  files["/proc/meminfo"] = "MemTotal: 8131788 kB\n";
  files[`${root}/host/memory.max`] = String(1024 ** 3);
  files[`${workload}/cpu.max`] = "max 100000";
  Object.assign(evidence.cpuSplit.workload, { cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: "cpuset_unavailable" } });
  const projection = ports.budget.getMockImplementation()!();
  Object.assign(projection.memoryBudget, { measuredMemoryBytes: String(8131788 * 1024),
    hostMemoryMax: String(1024 ** 3), source: "fallback", capped: false });
  expect(qualify()).toMatchObject({ cpuMax: "400000 100000", memoryMax: String(7 * 1024 ** 3), pidsMax: "4096",
    memoryBudget: projection.memoryBudget });
});
it("binds nominal CPU to the root admitted SKU, independently of cpuset", () => {
  const projection = ports.budget.getMockImplementation()!();
  projection.resources.cpuMillicores = 8000;
  expect(qualify).toThrow();
});
