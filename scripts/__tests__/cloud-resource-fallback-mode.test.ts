import { expect, it } from "vitest";
import { cloudRuntimeBudget } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { cloudAllocationCapacity, cloudResourcesMeetContract, cloudRuntimeResourcesQualified } from "../cloud-workspace-validation/sandbox/cloud-resource-admission.mjs";

const GiB = 1024 ** 3, root = "/sys/fs/cgroup/system.slice/zeros-host.service";
const engine = `${root}/engine-runtime/engine-00000000-0000-4000-8000-000000000000`;
function pair(reason: "cpu" | "memory", cpus: number, hostMemoryMax = GiB / 4, gib = 8) {
  const measuredKiB = gib === 8 ? 8131788 : Math.floor(gib * GiB * 0.98 / 1024);
  const budgetRead = (file: string) => {
    if (file === "/proc/meminfo" && reason !== "memory") return `MemTotal: ${measuredKiB} kB\n`;
    if (file.endsWith("/cpuset.cpus.effective") && reason !== "cpu") return `0-${cpus - 1}`;
    throw Object.assign(new Error("fixture unavailable"), { code: "ENOENT" });
  };
  const budget = cloudRuntimeBudget(engine, budgetRead, undefined, gib * GiB, hostMemoryMax, cpus * 1000);
  const allocation = cloudAllocationCapacity({ isolated: false, membership: `0::${root.slice("/sys/fs/cgroup".length)}\n`,
    read: (file: string) => file === "/proc/meminfo" ? `MemTotal: ${measuredKiB} kB\n` : null,
    architecture: "x64", availableCPUs: cpus, storageBytes: 40 * GiB });
  const contract = { architecture: "linux/amd64", cpuMillicores: cpus * 1000, memoryMiB: gib * 1024, storageMiB: 40960 };
  const observed = { finite: true, cpuMax: budget.limits["cpu.max"], memoryMax: budget.limits["memory.max"],
    pidsMax: budget.limits["pids.max"], allocation, memoryBudget: budget.memoryBudget,
    cpuSplit: { engine: { cpuMax: "max 100000", cpuWeight: 100 },
      workload: { controllers: ["cpu"], cpuWeight: 100, cap: budget.cap } } };
  return { budget, contract, observed };
}
const fallbackCases = (["cpu", "memory"] as const).flatMap(reason =>
  [1, 2, 4, 8, 16].flatMap(cpus => [4, 8, 16].map(gib => ({ reason, cpus, gib }))));
it.each(fallbackCases)(
  "admits exact main fallback with $reason unavailable on a sufficient $cpus CPU / $gib GiB SKU", ({ reason, cpus, gib }) => {
    const { budget, contract, observed } = pair(reason, cpus, GiB / 4, gib);
    expect(budget.memoryBudget.source).toBe("fallback"); expect(budget.cap.kind).toBe("skipped");
    expect(budget.limits).toMatchObject({ "cpu.max": "400000 100000", "memory.max": String(7 * GiB), "pids.max": "4096", "memory.oom.group": "1" });
    expect(cloudRuntimeResourcesQualified(observed)).toBe(true);
    expect(cloudResourcesMeetContract(contract, observed)).toBe(true);
  });
it.each(["cpu", "memory"] as const)("retains the exact default four CPU %s fallback", reason => {
  const { contract, observed } = pair(reason, 4); expect(cloudResourcesMeetContract(contract, observed)).toBe(true);
});
it("keeps raw measurements honest without applying the nominal host-ceiling rule to fallback", () => {
  const { budget, contract, observed } = pair("cpu", 8, GiB);
  expect(budget.memoryBudget).toMatchObject({ measuredMemoryBytes: String(8131788 * 1024), hostMemoryMax: String(GiB), capped: false });
  expect(observed.memoryMax).toBe(String(7 * GiB)); expect(cloudResourcesMeetContract(contract, observed)).toBe(true);
});
it.each([{ cpuMax: "200000 100000" }, { cpuMax: null, finite: false }, { memoryMax: String(7 * GiB - 1) },
  { memoryMax: String(7 * GiB + 1) }, { pidsMax: "4095" }, { pidsMax: "4097" }])("never broadens fallback to arbitrary changed parent limits %j", change => {
  const { contract, observed } = pair("cpu", 8);
  expect(cloudRuntimeResourcesQualified({ ...observed, ...change })).toBe(false);
  expect(cloudResourcesMeetContract(contract, { ...observed, ...change })).toBe(false);
});
it("retains the actual allocation CPU floor for the larger SKU", () => {
  const { contract, observed } = pair("cpu", 8);
  expect(cloudResourcesMeetContract(contract, { ...observed, allocation: { ...observed.allocation, cpuMillicores: 4000 } })).toBe(false);
});
it("does not infer a main fallback from numbers without its explicit root decision and skip diagnostic", () => {
  const { contract, observed } = pair("cpu", 8);
  const { source: _source, ...unrecorded } = observed.memoryBudget;
  expect(cloudResourcesMeetContract(contract, { ...observed, memoryBudget: unrecorded })).toBe(false);
  expect(cloudResourcesMeetContract(contract, { ...observed, memoryBudget: { ...observed.memoryBudget, source: "nominal" } })).toBe(false);
  expect(cloudResourcesMeetContract(contract, { ...observed, cpuSplit: { ...observed.cpuSplit,
    workload: { ...observed.cpuSplit.workload, cap: { kind: "applied", effectiveCpus: 8, cpuMax: "300000 100000" } } } })).toBe(false);
});
it("refuses a capped fallback claim even when raw measurements are genuine", () => {
  const { contract, observed } = pair("cpu", 8, GiB);
  expect(cloudResourcesMeetContract(contract, { ...observed,
    memoryBudget: { ...observed.memoryBudget, capped: true } })).toBe(false);
});
