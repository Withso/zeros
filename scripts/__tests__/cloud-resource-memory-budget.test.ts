import { expect, it } from "vitest";
import { cloudResourcesMeetContract, cloudRuntimeResourcesQualified } from "../cloud-workspace-validation/sandbox/cloud-resource-admission.mjs";

const GiB = 1024 ** 3;
const allocation = (gib = 8) => ({ architecture: "linux/amd64", cpuMillicores: 4000,
  memoryBytes: Math.floor(gib * GiB * 0.98 / 1024) * 1024, storageBytes: 40 * GiB });
const contract = (gib = 8) => ({ architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: gib * 1024, storageMiB: 40960 });
function report(gib = 8, hostMemoryMax = GiB / 4) {
  const measuredMemoryBytes = allocation(gib).memoryBytes;
  const target = (gib - 1) * GiB, ceiling = measuredMemoryBytes - hostMemoryMax;
  return { finite: true, cpuMax: "400000 100000", memoryMax: String(Math.min(target, ceiling)), pidsMax: "4096",
    allocation: allocation(gib), memoryBudget: { nominalMemoryBytes: String(gib * GiB),
      measuredMemoryBytes: String(measuredMemoryBytes), hostMemoryMax: String(hostMemoryMax), source: "nominal", capped: ceiling < target },
    cpuSplit: { engine: { cpuMax: "max 100000", cpuWeight: 100 },
      workload: { controllers: ["cpu"], cpuWeight: 100, cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300000 100000" } } } };
}

it.each([4, 8, 16])("keeps nominal %i GiB minus one GiB despite ordinary kernel accounting overhead", gib => {
  const value = report(gib);
  expect(value.memoryMax).toBe(String((gib - 1) * GiB));
  expect(value.memoryBudget.capped).toBe(false);
  expect(cloudRuntimeResourcesQualified(value)).toBe(true);
  expect(cloudResourcesMeetContract(contract(gib), value)).toBe(true);
});
it("accepts the existing measured MemTotal fixture without changing main's seven GiB", () => {
  const value = report(); value.allocation.memoryBytes = 8131788 * 1024;
  value.memoryBudget.measuredMemoryBytes = String(value.allocation.memoryBytes);
  expect(cloudResourcesMeetContract(contract(), value)).toBe(true);
});
it.each([4, 8, 16])("records a genuine measured-minus-host cap for %i GiB without dropping the SKU floor", gib => {
  const value = report(gib, GiB);
  expect(value.memoryBudget.capped).toBe(true);
  expect(value.memoryMax).toBe(String(value.allocation.memoryBytes - GiB));
  expect(cloudRuntimeResourcesQualified(value)).toBe(true);
  expect(cloudResourcesMeetContract(contract(gib), value)).toBe(true);
});
it("retains seven GiB only as an explicit unmeasurable fallback, including larger nominal SKUs", () => {
  const value = report(16);
  const fallback = { ...value, memoryMax: String(7 * GiB), memoryBudget: {
    ...value.memoryBudget, measuredMemoryBytes: null, source: "fallback", capped: false }, cpuSplit: {
      ...value.cpuSplit, workload: { ...value.cpuSplit.workload,
        cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: "memory_unavailable" } } } };
  expect(cloudRuntimeResourcesQualified(fallback)).toBe(true);
  expect(cloudResourcesMeetContract(contract(16), fallback)).toBe(true);
  expect(cloudResourcesMeetContract(contract(16), { ...fallback, memoryMax: String(15 * GiB) })).toBe(false);
});
it.each([null, String(16 * GiB)])("retains a genuinely known measurement when fallback nominal is %s", nominalMemoryBytes => {
  const value = report(16), fallback = { ...value, memoryMax: String(7 * GiB), memoryBudget: {
    ...value.memoryBudget, nominalMemoryBytes, source: "fallback", capped: false }, cpuSplit: {
      ...value.cpuSplit, workload: { ...value.cpuSplit.workload,
        cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: "cpuset_unavailable" } } } };
  expect(cloudRuntimeResourcesQualified(fallback)).toBe(true);
  expect(cloudResourcesMeetContract(contract(16), fallback)).toBe(true);
});
it("keeps exact main fallback despite a known lower nominal host ceiling", () => {
  const value = report(8, GiB), fallback = { ...value, memoryMax: String(7 * GiB),
    memoryBudget: { ...value.memoryBudget, source: "fallback", capped: false },
    cpuSplit: { ...value.cpuSplit, workload: { ...value.cpuSplit.workload,
      cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: "cpuset_unavailable" } } } };
  expect(cloudRuntimeResourcesQualified(fallback)).toBe(true);
  expect(cloudResourcesMeetContract(contract(), fallback)).toBe(true);
  expect(cloudRuntimeResourcesQualified({ ...fallback, memoryBudget: { ...fallback.memoryBudget, capped: true } })).toBe(false);
});
it("requires fallback to retain its actual unavailable-cap cause", () => {
  const value = report();
  expect(cloudRuntimeResourcesQualified({ ...value, memoryBudget: { ...value.memoryBudget, source: "fallback" } })).toBe(false);
});
it.each([
  undefined, null, {}, { extra: true }, { source: "other" }, { capped: true },
  { nominalMemoryBytes: null }, { measuredMemoryBytes: null }, { hostMemoryMax: null },
  { nominalMemoryBytes: "8589934593" }, { measuredMemoryBytes: "0" }, { hostMemoryMax: "max" },
  { hostMemoryMax: String(8 * GiB) }, { nominalMemoryBytes: "9223372036854775808" },
  { measuredMemoryBytes: "9223372036854775808" }, { hostMemoryMax: "9223372036854775808" },
])("refuses missing, contradictory or malformed current memory-budget evidence %j", change => {
  const value = report();
  const memoryBudget = change === undefined || change === null || Object.keys(change).length === 0
    ? change : { ...value.memoryBudget, ...change };
  expect(cloudRuntimeResourcesQualified({ ...value, memoryBudget })).toBe(false);
  expect(cloudResourcesMeetContract(contract(), { ...value, memoryBudget })).toBe(false);
});
it("binds nominal memory to the admitted SKU instead of trusting a smaller reported nominal", () => {
  const value = report(4); value.allocation = allocation(8);
  expect(cloudRuntimeResourcesQualified(value)).toBe(true);
  expect(cloudResourcesMeetContract(contract(), value)).toBe(false);
});
it("rejects an actually smaller ancestor bound even when the cap and allocation are valid", () => {
  const value = report(8, GiB);
  expect(cloudResourcesMeetContract(contract(), { ...value, memoryMax: String(BigInt(value.memoryMax) - 1n) })).toBe(false);
});
it("keeps the measured allocation floor independent of the recorded cap", () => {
  const value = report(8, GiB); value.allocation.memoryBytes = Math.floor(8 * GiB * 0.93);
  expect(cloudResourcesMeetContract(contract(), value)).toBe(false);
});
it("does not accept an output above the observed host reserve ceiling", () => {
  const value = report(8, GiB);
  expect(cloudRuntimeResourcesQualified({ ...value, memoryMax: String(7 * GiB) })).toBe(false);
});
it("preserves the exact archived v1 memory floor and ignores v2-only proof in that reader", () => {
  const { cpuSplit: _split, memoryBudget: _budget, ...legacy } = report();
  expect(cloudResourcesMeetContract(contract(), legacy)).toBe(true);
  expect(cloudResourcesMeetContract(contract(), { ...legacy, memoryMax: String(7 * GiB - 1) })).toBe(false);
  expect(cloudResourcesMeetContract(contract(), { ...legacy, memoryBudget: { source: "unknown" } })).toBe(true);
});
