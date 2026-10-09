import { expect, it } from "vitest";
import { cloudResourcesMeetContract, cloudRuntimeResourcesQualified } from "../cloud-workspace-validation/sandbox/cloud-resource-admission.mjs";

const contract = { architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 40960 };
const measured = () => ({ finite: true, cpuMax: "400000 100000", memoryMax: String(7 * 1024 ** 3), pidsMax: "4096",
  memoryBudget: { nominalMemoryBytes: String(8 * 1024 ** 3), measuredMemoryBytes: String(8 * 1024 ** 3),
    hostMemoryMax: String(256 * 1024 ** 2), source: "nominal", capped: false },
  allocation: { architecture: "linux/amd64", cpuMillicores: 4000, memoryBytes: 8 * 1024 ** 3, storageBytes: 40 * 1024 ** 3 },
  cpuSplit: { engine: { cpuMax: "max 100000", cpuWeight: 100 },
    workload: { controllers: ["cpu"], cpuWeight: 100, cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300000 100000" } } } });

it("admits the actual common-parent limits and exact shared CPU split", () => {
  expect(cloudRuntimeResourcesQualified(measured())).toBe(true);
  expect(cloudResourcesMeetContract(contract, measured())).toBe(true);
});
it("keeps actual unbounded CPU observable but rejects it against the nominal SKU", () => {
  const value = { ...measured(), finite: false, cpuMax: null };
  expect(cloudRuntimeResourcesQualified(value)).toBe(true);
  expect(cloudResourcesMeetContract(contract, value)).toBe(false);
  expect(cloudResourcesMeetContract(contract, { ...value, cpuSplit: undefined })).toBe(false);
});
it.each([1, 2, 4, 8, 16])("binds %i effective CPUs to the smaller actual ancestor quota", effectiveCpus => {
  const value = measured();
  value.cpuSplit.workload.cap = { kind: "applied", effectiveCpus, cpuMax: `${Math.min(effectiveCpus, 4) * 75000} 100000` };
  expect(cloudRuntimeResourcesQualified(value)).toBe(true);
  value.cpuSplit.workload.cap.cpuMax = `${Math.min(effectiveCpus, 4) * 75000 + 1} 100000`;
  expect(cloudRuntimeResourcesQualified(value)).toBe(false);
});
it("rounds fractional ancestor quota with exact rational arithmetic", () => {
  const value = measured(); value.cpuMax = "700000 200000";
  value.cpuSplit.workload.cap.cpuMax = "262500 100000";
  expect(cloudRuntimeResourcesQualified(value)).toBe(true);
  value.cpuMax = "400003 100001";
  value.cpuSplit.workload.cap.cpuMax = "299999 100000";
  expect(cloudRuntimeResourcesQualified(value)).toBe(true);
});
it.each(["cpuset_unavailable", "cpuset_invalid", "memory_unavailable", "memory_invalid"])("retains only the closed optional-cap diagnostic %s", diagnostic => {
  const value = { ...measured(), cpuSplit: { ...measured().cpuSplit,
    workload: { controllers: ["cpu"], cpuWeight: 100, cap: { kind: "skipped", cpuMax: "max 100000", diagnostic } } } };
  value.memoryBudget.source = "fallback";
  expect(cloudRuntimeResourcesQualified(value)).toBe(true);
  expect(cloudResourcesMeetContract(contract, value)).toBe(true);
});
it.each([
  { finite: false }, { cpuMax: "max 100000" }, { cpuMax: "0 100000" }, { cpuMax: "9223372036854775808 100000" },
  { memoryMax: null }, { memoryMax: "max" }, { memoryMax: "0" }, { memoryMax: "9223372036854775808" },
  { pidsMax: null }, { pidsMax: "0" }, { pidsMax: "max" }, { cpuSplit: null },
])("refuses lost, contradictory or malformed current resource evidence %j", change => {
  expect(cloudRuntimeResourcesQualified({ ...measured(), ...change })).toBe(false);
  expect(cloudResourcesMeetContract(contract, { ...measured(), ...change })).toBe(false);
});
it.each([
  { engine: { cpuMax: "400000 100000", cpuWeight: 100 } },
  { engine: { cpuMax: "max 100000", cpuWeight: 100, extra: true } },
  { workload: { controllers: ["cpu", "memory"], cpuWeight: 100, cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: "cpuset_unavailable" } } },
  { workload: { controllers: ["cpu"], cpuWeight: 99, cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300000 100000" } } },
  { workload: { controllers: ["cpu"], cpuWeight: 100, cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: "private error" } } },
  { workload: { controllers: ["cpu"], cpuWeight: 100, cap: { kind: "applied", effectiveCpus: 65537, cpuMax: "300000 100000" } } },
])("refuses changed split policy or unknown fields %j", change => {
  expect(cloudRuntimeResourcesQualified({ ...measured(), cpuSplit: { ...measured().cpuSplit, ...change } })).toBe(false);
});
it.each(["cpuMillicores", "memoryBytes", "storageBytes"] as const)("keeps the existing allocation/SKU floor for %s", field => {
  const value = measured(); value.allocation[field] = 1;
  expect(cloudResourcesMeetContract(contract, value)).toBe(false);
});
it("does not turn a missing bounded parent or a smaller tenant allocation into success", () => {
  expect(cloudResourcesMeetContract(contract, { ...measured(), memoryMax: String(7 * 1024 ** 3 - 1) })).toBe(false);
  expect(cloudResourcesMeetContract(contract, { ...measured(), cpuMax: "200000 100000",
    cpuSplit: { ...measured().cpuSplit, workload: { ...measured().cpuSplit.workload,
      cap: { kind: "applied", effectiveCpus: 4, cpuMax: "150000 100000" } } } })).toBe(false);
});
