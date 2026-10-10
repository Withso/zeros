import { expect, it } from "vitest";
import { cloudRuntimeBudget } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { cloudAllocationCapacity, cloudResourcesMeetContract, cloudRuntimeResourcesQualified } from "../cloud-workspace-validation/sandbox/cloud-resource-admission.mjs";

const GiB = 1024 ** 3, root = "/sys/fs/cgroup/system.slice/zeros-host.service";
const engine = `${root}/engine-runtime/engine-00000000-0000-4000-8000-000000000000`;
function pair(gib: number, measuredKiB: number, hostMemoryMax = GiB / 4, parentMemoryMax?: number,
  nominal: number | null = gib * GiB, cpus = 4, effectiveCpus = cpus) {
  const read = (file: string) => file === "/proc/meminfo" ? `MemTotal: ${measuredKiB} kB\n`
    : file.endsWith("/cpuset.cpus.effective") ? `0-${effectiveCpus - 1}`
      : file === `${root}/memory.max` && parentMemoryMax !== undefined ? String(parentMemoryMax) : null;
  const allocation = cloudAllocationCapacity({ isolated: false, membership: `0::${root.slice("/sys/fs/cgroup".length)}\n`,
    read, architecture: "x64", availableCPUs: effectiveCpus, storageBytes: 40 * GiB });
  const budgetRead = (file: string) => {
    const value = read(file); if (value === null) throw Object.assign(new Error("fixture absent"), { code: "ENOENT" }); return value;
  };
  const budget = cloudRuntimeBudget(engine, budgetRead, undefined, nominal ?? undefined, hostMemoryMax, cpus * 1000);
  const contract = { architecture: "linux/amd64", cpuMillicores: cpus * 1000, memoryMiB: gib * 1024, storageMiB: 40960 };
  const observed = { finite: true, cpuMax: budget.limits["cpu.max"],
    memoryMax: String(Math.min(Number(budget.limits["memory.max"]), parentMemoryMax ?? Infinity)), pidsMax: budget.limits["pids.max"],
    allocation, memoryBudget: budget.memoryBudget, cpuSplit: { engine: { cpuMax: "max 100000", cpuWeight: 100 },
      workload: { controllers: ["cpu"], cpuWeight: 100, cap: budget.cap } } };
  return { budget, contract, observed };
}
it("joins the existing MemTotal fixture to exact main's seven GiB and unchanged admission floor", () => {
  const { budget, contract, observed } = pair(8, 8131788);
  expect(observed.allocation.memoryBytes).toBe(8131788 * 1024);
  expect(budget.limits["memory.max"]).toBe(String(7 * GiB));
  expect(budget.memoryBudget).toMatchObject({ nominalMemoryBytes: String(8 * GiB), measuredMemoryBytes: String(8131788 * 1024),
    hostMemoryMax: String(GiB / 4), source: "nominal", capped: false });
  expect(cloudResourcesMeetContract(contract, observed)).toBe(true);
});
it.each([4, 8, 16])("joins the actual producer/admission at %i GiB with two percent kernel overhead", gib => {
  const { budget, contract, observed } = pair(gib, Math.floor(gib * GiB * 0.98 / 1024));
  expect(budget.limits["memory.max"]).toBe(String((gib - 1) * GiB));
  expect(cloudResourcesMeetContract(contract, observed)).toBe(true);
});
it.each([1, 2, 4, 8, 16])("binds nominal %i CPU to the admitted SKU independently of a larger real cpuset", cpus => {
  const { budget, contract, observed } = pair(8, 8131788, GiB / 4, undefined, 8 * GiB, cpus, 32);
  expect(budget.memoryBudget.source).toBe("nominal");
  expect(budget.limits["cpu.max"]).toBe(`${cpus * 100000} 100000`);
  expect(budget.cap).toEqual({ kind: "applied", effectiveCpus: 32, cpuMax: `${cpus * 75000} 100000` });
  expect(cloudResourcesMeetContract(contract, observed)).toBe(true);
  const foreignCpu = cpus === 4 ? 8 : 4;
  const changed = { ...observed, cpuMax: `${foreignCpu * 100000} 100000`, cpuSplit: { ...observed.cpuSplit,
    workload: { ...observed.cpuSplit.workload, cap: { kind: "applied", effectiveCpus: 32, cpuMax: `${foreignCpu * 75000} 100000` } } } };
  expect(cloudRuntimeResourcesQualified(changed)).toBe(true);
  expect(cloudResourcesMeetContract(contract, changed)).toBe(false);
});
it("records an actual host-ceiling cap and retains the allocation/SKU floor", () => {
  const { budget, contract, observed } = pair(8, 8131788, GiB);
  expect(budget.memoryBudget.capped).toBe(true);
  expect(budget.limits["memory.max"]).toBe(String(8131788 * 1024 - GiB));
  expect(cloudResourcesMeetContract(contract, observed)).toBe(true);
});
it("keeps raw measurement separate from the actually smaller ancestor allocation", () => {
  const { budget, contract, observed } = pair(8, 8131788, GiB / 4, 4 * GiB);
  expect(budget.memoryBudget.measuredMemoryBytes).toBe(String(8131788 * 1024));
  expect(observed.allocation.memoryBytes).toBe(4 * GiB);
  expect(cloudResourcesMeetContract(contract, observed)).toBe(false);
});
it("rejects a smaller common ancestor even when the nominal SKU floor is satisfied", () => {
  const { budget, contract, observed } = pair(8, 8131788);
  expect(cloudResourcesMeetContract(contract, { ...observed, memoryMax: String(BigInt(budget.limits["memory.max"]) - 1n) })).toBe(false);
});
it("preserves genuine fallback measurements without manufacturing nominal allocation", () => {
  const { budget, contract, observed } = pair(8, 8131788, GiB, undefined, null);
  expect(budget.memoryBudget).toMatchObject({ nominalMemoryBytes: null, measuredMemoryBytes: String(8131788 * 1024), source: "fallback", capped: false });
  expect(budget.limits["memory.max"]).toBe(String(7 * GiB));
  expect(budget.cap).toMatchObject({ kind: "skipped", diagnostic: "memory_unavailable" });
  expect(cloudRuntimeResourcesQualified(observed)).toBe(true);
  expect(cloudResourcesMeetContract(contract, observed)).toBe(true);
});
it("keeps a genuinely undersized SKU and archived v1 exact", () => {
  const { contract, observed } = pair(8, 7 * GiB / 1024);
  expect(cloudResourcesMeetContract(contract, observed)).toBe(false);
  const { cpuSplit: _split, memoryBudget: _budget, ...legacy } = pair(8, 8131788).observed;
  expect(cloudResourcesMeetContract(contract, { ...legacy, memoryMax: String(7 * GiB) })).toBe(true);
  expect(cloudResourcesMeetContract(contract, { ...legacy, memoryMax: String(7 * GiB - 1) })).toBe(false);
});
