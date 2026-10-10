import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyRuntimeTransferReport } from "./runtime-transfer-proof.js";
import { legacyTransferReport, vmTransferReport, transferActive, transferResources } from "./runtime-transfer-proof.test-fixtures.js";
// @ts-expect-error The image helper is standalone JavaScript; parity runs its actual bytes.
import { cloudResourcesMeetContract } from "../../../../scripts/cloud-workspace-validation/sandbox/cloud-resource-admission.mjs";

const gib = 1024 ** 3;
function memoryBudgetReport(nominalMemoryBytes: number, measuredMemoryBytes = nominalMemoryBytes, hostMemoryMax = gib) {
  const report = vmTransferReport();
  const target = nominalMemoryBytes - gib, ceiling = measuredMemoryBytes - hostMemoryMax;
  return { ...report, resources: { ...report.resources,
    cpuMax: "200000 100000",
    memoryMax: String(Math.min(target, ceiling)),
    allocation: { ...report.resources.allocation, memoryBytes: measuredMemoryBytes },
    memoryBudget: { nominalMemoryBytes: String(nominalMemoryBytes), measuredMemoryBytes: String(measuredMemoryBytes),
      hostMemoryMax: String(hostMemoryMax), source: "nominal", capped: ceiling < target },
  } };
}

describe("explicit whole-parent bounds mode", () => {
  it.each([1, 2, 4, 8, 16].flatMap(cpus => [4, 8, 16].map(memoryGiB => ({ cpus, memoryGiB })) ))(
    "accepts EXACT main fallback for $cpus CPUs / $memoryGiB GiB only with sufficient actual allocation", ({ cpus, memoryGiB }) => {
      const nominal = memoryGiB * gib, measured = Math.floor(nominal * 0.98);
      const original = memoryBudgetReport(nominal, measured);
      const report = { ...original, resources: { ...original.resources, cpuMax: "400000 100000",
        memoryMax: String(7 * gib), pidsMax: "4096", allocation: { ...original.resources.allocation, cpuMillicores: cpus * 1000 },
        memoryBudget: { ...original.resources.memoryBudget, source: "fallback", capped: false },
        cpuSplit: { ...original.resources.cpuSplit, workload: { controllers: ["cpu"], cpuWeight: 100,
          cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: "cpuset_unavailable" } } },
      } };
      const expected = { ...transferResources, cpuMillicores: cpus * 1000, memoryMiB: memoryGiB * 1024 };
      expect(verifyRuntimeTransferReport(report, transferActive, expected))
        .toEqual(createHash("sha256").update(JSON.stringify(report) + "\n").digest());
      for (const changed of [
        { ...report.resources, cpuMax: "200000 100000" },
        { ...report.resources, memoryMax: String(7 * gib - 1) },
        { ...report.resources, memoryMax: String(7 * gib + 1) },
        { ...report.resources, pidsMax: "4095" },
        { ...report.resources, memoryBudget: { ...report.resources.memoryBudget, capped: true } },
        { ...report.resources, memoryBudget: { ...report.resources.memoryBudget, source: "nominal" } },
        { ...report.resources, allocation: { ...report.resources.allocation, cpuMillicores: cpus * 1000 - 1 } },
        { ...report.resources, allocation: { ...report.resources.allocation, memoryBytes: Math.floor(nominal * 0.94) - 1 } },
      ]) expect(verifyRuntimeTransferReport({ ...report, resources: changed }, transferActive, expected)).toBeNull();
    });

  it.each([1, 2, 4, 8, 16])("requires nominal mode to bind the actual parent to the admitted %i CPU SKU", cpus => {
    const original = memoryBudgetReport(8 * gib);
    const report = { ...original, resources: { ...original.resources, cpuMax: `${cpus * 100000} 100000`,
      allocation: { ...original.resources.allocation, cpuMillicores: cpus * 1000 },
      cpuSplit: { ...original.resources.cpuSplit, workload: { ...original.resources.cpuSplit.workload,
        cap: { kind: "applied", effectiveCpus: cpus, cpuMax: `${cpus * 75000} 100000` } } },
    } };
    const expected = { ...transferResources, cpuMillicores: cpus * 1000, memoryMiB: 8192 };
    expect(verifyRuntimeTransferReport(report, transferActive, expected)).not.toBeNull();
    const wrong = cpus + 1;
    expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources, cpuMax: `${wrong * 100000} 100000`,
      cpuSplit: { ...report.resources.cpuSplit, workload: { ...report.resources.cpuSplit.workload,
        cap: { kind: "applied", effectiveCpus: wrong, cpuMax: `${wrong * 75000} 100000` } } },
    } }, transferActive, expected)).toBeNull();
  });

  it.each([
    { cpuMax: "2000 1000", cpuMillicores: 2000, workloadCpuMax: "150000 100000" },
    { cpuMax: "400000 200000", cpuMillicores: 2000, workloadCpuMax: "150000 100000" },
    { cpuMax: "9223372036854775807 9223372036854775807", cpuMillicores: 1000, workloadCpuMax: "75000 100000" },
  ])("requires the canonical nominal parent period for $cpuMax", ({ cpuMax, cpuMillicores, workloadCpuMax }) => {
    const original = memoryBudgetReport(8 * gib);
    const report = { ...original, resources: { ...original.resources, cpuMax,
      cpuSplit: { ...original.resources.cpuSplit, workload: { ...original.resources.cpuSplit.workload,
        cap: { kind: "applied", effectiveCpus: 2, cpuMax: workloadCpuMax } } },
    } };
    expect(verifyRuntimeTransferReport(report, transferActive, { ...transferResources, cpuMillicores, memoryMiB: 8192 })).toBeNull();
  });

  it("uses only the root-decided memory source as mode and leaves v1 byte shape unchanged", () => {
    const report = memoryBudgetReport(8 * gib), expected = { ...transferResources, memoryMiB: 8192 };
    expect(verifyRuntimeTransferReport(report, transferActive, expected)).not.toBeNull();
    for (const source of [undefined, null, "legacy", 1, "fallback"]) {
      expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources,
        memoryBudget: { ...report.resources.memoryBudget, source },
      } }, transferActive, expected)).toBeNull();
    }
    for (const boundsMode of ["nominal", "fallback"]) {
      expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources, boundsMode } }, transferActive, expected)).toBeNull();
    }
    const legacy = legacyTransferReport();
    expect(verifyRuntimeTransferReport(legacy, transferActive, transferResources)).not.toBeNull();
    expect(verifyRuntimeTransferReport({ ...legacy, resources: { ...legacy.resources, boundsMode: "nominal" } }, transferActive, transferResources)).toBeNull();
  });

  it.each([Number.NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses unusable admitted CPU %s without throwing", cpuMillicores => {
      const report = memoryBudgetReport(8 * gib);
      expect(verifyRuntimeTransferReport(report, transferActive, { ...transferResources, memoryMiB: 8192, cpuMillicores })).toBeNull();
    });
});

describe("recorded v2 memory budget and measured SKU accounting", () => {
  it.each([4, 8, 16])("accepts genuine %i GiB nominal budgets capped by actual memory after host reserve", memoryGiB => {
    const nominal = memoryGiB * gib, measured = Math.floor(nominal * 0.98);
    const report = memoryBudgetReport(nominal, measured);
    const expected = { ...transferResources, memoryMiB: memoryGiB * 1024 };
    expect(verifyRuntimeTransferReport(report, transferActive, expected))
      .toEqual(createHash("sha256").update(JSON.stringify(report) + "\n").digest());
  });

  it("accepts the actual eight-GiB MemTotal fixture and exact 94% floor, but refuses a smaller allocation", () => {
    const nominal = 8 * gib, expected = { ...transferResources, memoryMiB: 8192 };
    for (const measured of [8131788 * 1024, Math.floor(nominal * 0.94)]) {
      const report = memoryBudgetReport(nominal, measured);
      report.resources.allocation.storageBytes = Math.floor(transferResources.storageMiB * 1024 ** 2 * 0.94);
      expect(verifyRuntimeTransferReport(report, transferActive, expected))
        .toEqual(createHash("sha256").update(JSON.stringify(report) + "\n").digest());
    }
    expect(verifyRuntimeTransferReport(memoryBudgetReport(nominal, Math.floor(nominal * 0.94) - 1), transferActive, expected)).toBeNull();
  });

  it("recomputes the exact capped or uncapped common parent and refuses dishonest flags or lower limits", () => {
    const expected = { ...transferResources, memoryMiB: 8192 };
    for (const report of [memoryBudgetReport(8 * gib), memoryBudgetReport(8 * gib, Math.floor(8 * gib * 0.98), 2 * gib)]) {
      expect(verifyRuntimeTransferReport(report, transferActive, expected)).not.toBeNull();
      for (const changed of [
        { ...report.resources, memoryMax: String(BigInt(report.resources.memoryMax) - 1n) },
        { ...report.resources, memoryMax: String(BigInt(report.resources.memoryMax) + 1n) },
        { ...report.resources, memoryBudget: { ...report.resources.memoryBudget, capped: !report.resources.memoryBudget.capped } },
      ]) expect(verifyRuntimeTransferReport({ ...report, resources: changed }, transferActive, expected)).toBeNull();
    }
  });

  it.each([null, String(8 * gib)])("accepts only the recorded exact-main fallback without inventing a measurement (nominal: %s)", nominalMemoryBytes => {
    const original = memoryBudgetReport(8 * gib), expected = { ...transferResources, memoryMiB: 8192 };
    const report = { ...original, resources: { ...original.resources, cpuMax: "400000 100000", memoryBudget: {
      nominalMemoryBytes, measuredMemoryBytes: null, hostMemoryMax: String(gib), source: "fallback", capped: false,
    }, cpuSplit: { ...original.resources.cpuSplit, workload: { controllers: ["cpu"], cpuWeight: 100,
      cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: "memory_unavailable" } } } } };
    expect(verifyRuntimeTransferReport(report, transferActive, expected))
      .toEqual(createHash("sha256").update(JSON.stringify(report) + "\n").digest());
    for (const budget of [
      { ...report.resources.memoryBudget, measuredMemoryBytes: String(Math.floor(8 * gib * 0.98)) },
      { ...report.resources.memoryBudget, capped: true },
    ]) expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources, memoryBudget: budget } }, transferActive, expected)).toBeNull();
  });

  it.each([null, String(8 * gib)])("retains known measurements without capping main's fallback (nominal: %s)", nominalMemoryBytes => {
    const measured = Math.floor(8 * gib * 0.98), original = memoryBudgetReport(8 * gib, measured);
    const expected = { ...transferResources, memoryMiB: 8192 };
    const report = { ...original, resources: { ...original.resources, cpuMax: "400000 100000", memoryMax: String(7 * gib), memoryBudget: {
      ...original.resources.memoryBudget, nominalMemoryBytes, source: "fallback", capped: false,
    }, cpuSplit: { ...original.resources.cpuSplit, workload: { controllers: ["cpu"], cpuWeight: 100,
      cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: nominalMemoryBytes === null ? "memory_unavailable" : "cpuset_unavailable" } } } } };
    expect(verifyRuntimeTransferReport(report, transferActive, expected))
      .toEqual(createHash("sha256").update(JSON.stringify(report) + "\n").digest());
    expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources,
      cpuSplit: original.resources.cpuSplit } }, transferActive, expected)).toBeNull();
    expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources,
      memoryBudget: { ...report.resources.memoryBudget, measuredMemoryBytes: String(8 * gib) } } }, transferActive, expected)).not.toBeNull();
    expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources,
      memoryMax: original.resources.memoryMax, memoryBudget: { ...report.resources.memoryBudget, capped: true },
    } }, transferActive, expected)).toBeNull();
  });

  it("requires strict signed64 memory metadata with positive target and recorded host cap", () => {
    const report = memoryBudgetReport(8 * gib), expected = { ...transferResources, memoryMiB: 8192 };
    const { memoryBudget: _omitted, ...withoutBudget } = report.resources;
    expect(verifyRuntimeTransferReport({ ...report, resources: withoutBudget }, transferActive, expected)).toBeNull();
    for (const memoryBudget of [
      null, { ...report.resources.memoryBudget, source: "measured" },
      { ...report.resources.memoryBudget, nominalMemoryBytes: null },
      { ...report.resources.memoryBudget, nominalMemoryBytes: String(gib) },
      { ...report.resources.memoryBudget, nominalMemoryBytes: String(16 * gib) },
      { ...report.resources.memoryBudget, measuredMemoryBytes: null },
      { ...report.resources.memoryBudget, measuredMemoryBytes: "0" },
      { ...report.resources.memoryBudget, measuredMemoryBytes: "9223372036854775808" },
      { ...report.resources.memoryBudget, measuredMemoryBytes: String(gib) },
      { ...report.resources.memoryBudget, hostMemoryMax: "0" },
      { ...report.resources.memoryBudget, hostMemoryMax: "1073741824\n" },
      { ...report.resources.memoryBudget, hostMemoryMax: gib },
      { ...report.resources.memoryBudget, capped: "false" },
      { ...report.resources.memoryBudget, rawException: "private details" },
    ]) expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources, memoryBudget } }, transferActive, expected)).toBeNull();
  });

  it.each(["nominalMemoryBytes", "measuredMemoryBytes", "hostMemoryMax"])(
    "refuses dirty nested %s before conversion without throwing", field => {
      const report = memoryBudgetReport(8 * gib), expected = { ...transferResources, memoryMiB: 8192 };
      for (const invalid of ["invalid", "1.5", "", "01", "+1", "-1", "0", "9223372036854775808", "1073741824\n"]) {
        expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources,
          memoryBudget: { ...report.resources.memoryBudget, [field]: invalid },
        } }, transferActive, expected)).toBeNull();
      }
    });

  it.each([Number.NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER])("refuses unusable admitted memory %s without throwing", memoryMiB => {
    const original = memoryBudgetReport(8 * gib);
    const report = { ...original, resources: { ...original.resources, cpuMax: "400000 100000", memoryBudget: {
      ...original.resources.memoryBudget, source: "fallback", nominalMemoryBytes: null,
    }, cpuSplit: { ...original.resources.cpuSplit, workload: { controllers: ["cpu"], cpuWeight: 100,
      cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: "memory_unavailable" } } } } };
    expect(verifyRuntimeTransferReport(report, transferActive, { ...transferResources, memoryMiB })).toBeNull();
  });

  it("matches the actual standalone v2 admission helper for raw RAM, upstream capacity and fallback proofs", () => {
    const original = memoryBudgetReport(8 * gib), memory = original.resources.memoryBudget;
    const expected = { ...transferResources, memoryMiB: 8192 };
    const allocations = { ...original.resources.allocation, architecture: "linux/amd64" };
    const ready = { ...original.resources, cpuMax: "200000 100000", allocation: allocations };
    const fallback = { ...ready, cpuMax: "400000 100000", memoryBudget: { ...memory, source: "fallback" }, cpuSplit: {
      ...ready.cpuSplit, workload: { controllers: ["cpu"], cpuWeight: 100,
        cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: "cpuset_unavailable" } },
    } };
    for (const resources of [
      ready, { ...ready, allocation: { ...allocations, memoryBytes: Math.floor(8 * gib * 0.94) } },
      fallback, { ...fallback, memoryBudget: { ...fallback.memoryBudget, nominalMemoryBytes: null } },
      { ...fallback, memoryBudget: { ...fallback.memoryBudget, measuredMemoryBytes: null } },
      { ...ready, allocation: { ...allocations, memoryBytes: Math.floor(8 * gib * 0.94) - 1 } },
      { ...ready, memoryMax: "7516192767" },
      { ...ready, memoryBudget: { ...memory, nominalMemoryBytes: String(16 * gib) } },
      { ...ready, memoryBudget: { ...memory, measuredMemoryBytes: null } },
      { ...ready, memoryBudget: { ...memory, hostMemoryMax: "0" } },
      { ...ready, memoryBudget: { ...memory, capped: true } },
      { ...fallback, cpuSplit: ready.cpuSplit },
    ]) {
      const cpAccepted = verifyRuntimeTransferReport({ ...original, resources }, transferActive, expected) !== null;
      expect(cpAccepted).toBe(cloudResourcesMeetContract({ ...expected, architecture: "linux/amd64" }, resources));
    }
  });

  it("keeps CPU denial and archived v1 full-allocation accounting unchanged", () => {
    const report = memoryBudgetReport(8 * gib), expected = { ...transferResources, memoryMiB: 8192 };
    expect(verifyRuntimeTransferReport(report, transferActive, { ...expected, cpuMillicores: 4000 })).toBeNull();
    expect(verifyRuntimeTransferReport(report, transferActive, { ...expected, storageMiB: transferResources.storageMiB * 2 })).toBeNull();
    const legacy = legacyTransferReport();
    expect(verifyRuntimeTransferReport(legacy, transferActive, transferResources)).not.toBeNull();
    expect(verifyRuntimeTransferReport({ ...legacy, resources: { ...legacy.resources,
      allocation: { ...legacy.resources.allocation, memoryBytes: Math.floor(legacy.resources.allocation.memoryBytes * 0.98) },
    } }, transferActive, transferResources)).toBeNull();
    expect(verifyRuntimeTransferReport({ ...legacy, resources: { ...legacy.resources,
      memoryBudget: report.resources.memoryBudget } }, transferActive, transferResources)).toBeNull();
  });
});

describe("fixed installer runtime report readers", () => {
  it("keeps archived v1 report bytes readable without interpreting them as a new VM report", () => {
    const report = legacyTransferReport();
    expect(verifyRuntimeTransferReport(report, transferActive, transferResources))
      .toEqual(createHash("sha256").update(JSON.stringify(report) + "\n").digest());
    expect(verifyRuntimeTransferReport({ ...report, version: 2 }, transferActive, transferResources)).toBeNull();
  });

  it("accepts the non-root same-engine no-sandbox report and retains its exact digest", () => {
    const report = vmTransferReport();
    expect(verifyRuntimeTransferReport(report, transferActive, transferResources))
      .toEqual(createHash("sha256").update(JSON.stringify(report) + "\n").digest());
  });

  it.each([1, 2, 4, 8, 16, 65536])("accepts an uncapped engine and 75%% of %i CPUs bounded by the four-CPU parent", effectiveCpus => {
    const report = vmTransferReport();
    report.resources.cpuMax = "400000 100000";
    report.resources.allocation.cpuMillicores = 4000;
    report.resources.cpuSplit.workload.cap = { kind: "applied", effectiveCpus, cpuMax: `${Math.min(effectiveCpus, 4) * 75000} 100000` };
    expect(verifyRuntimeTransferReport(report, transferActive, { ...transferResources, cpuMillicores: 4000 }))
      .toEqual(createHash("sha256").update(JSON.stringify(report) + "\n").digest());
  });

  it.each([1, 2, 4, 8, 16])("refuses an unlimited parent instead of a nominal %i CPU SKU", effectiveCpus => {
    const report = vmTransferReport();
    report.resources.cpuMax = null;
    report.resources.finite = false;
    report.resources.allocation.cpuMillicores = effectiveCpus * 1000;
    report.resources.cpuSplit.workload.cap = { kind: "applied", effectiveCpus, cpuMax: `${effectiveCpus * 75000} 100000` };
    expect(verifyRuntimeTransferReport(report, transferActive, { ...transferResources, cpuMillicores: effectiveCpus * 1000 })).toBeNull();
  });

  it.each([1, 2, 4, 8, 16].flatMap(cpus => [4, 8, 16].map(memoryGiB => ({ cpus, memoryGiB }))))(
    "retains measured SKU sufficiency for $cpus CPUs / $memoryGiB GiB with one-GiB host reserve", ({ cpus, memoryGiB }) => {
      const report = vmTransferReport(), gib = 1024 ** 3;
      report.resources.cpuMax = `${cpus * 100000} 100000`;
      report.resources.memoryMax = String((memoryGiB - 1) * gib);
      report.resources.memoryBudget = { nominalMemoryBytes: String(memoryGiB * gib), measuredMemoryBytes: String(memoryGiB * gib),
        hostMemoryMax: String(gib), source: "nominal", capped: false };
      report.resources.allocation = { ...report.resources.allocation, cpuMillicores: cpus * 1000, memoryBytes: memoryGiB * gib };
      report.resources.cpuSplit.workload.cap = { kind: "applied", effectiveCpus: cpus, cpuMax: `${cpus * 75000} 100000` };
      const expected = { ...transferResources, cpuMillicores: cpus * 1000, memoryMiB: memoryGiB * 1024 };
      expect(verifyRuntimeTransferReport(report, transferActive, expected))
        .toEqual(createHash("sha256").update(JSON.stringify(report) + "\n").digest());
      expect(verifyRuntimeTransferReport(report, transferActive, { ...expected, memoryMiB: expected.memoryMiB * 2 })).toBeNull();
    });

  it.each([
    ["250000 100000", "187500 100000", 2500],
    ["125001 100000", "93751 100000", null],
    ["800000 300000", "200000 100000", null],
    ["9223372036854775807 9223372036854775807", "75000 100000", null],
  ] as const)("rounds 75%% of actual parent %s exactly to %s only for an admitted exact SKU", (parentCpuMax, workloadCpuMax, cpuMillicores) => {
    const report = vmTransferReport();
    report.resources.cpuMax = parentCpuMax;
    report.resources.allocation.cpuMillicores = 8000;
    report.resources.cpuSplit.workload.cap = { kind: "applied", effectiveCpus: 8, cpuMax: workloadCpuMax };
    const expected = { ...transferResources, cpuMillicores: cpuMillicores ?? transferResources.cpuMillicores };
    expect(verifyRuntimeTransferReport(report, transferActive, expected))
      .toEqual(cpuMillicores === null ? null : createHash("sha256").update(JSON.stringify(report) + "\n").digest());
    expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources, cpuSplit: { ...report.resources.cpuSplit,
      workload: { ...report.resources.cpuSplit.workload, cap: { ...report.resources.cpuSplit.workload.cap, cpuMax: "600000 100000" } },
    } } }, transferActive, expected)).toBeNull();
  });

  it.each(["cpuset_unavailable", "cpuset_invalid", "memory_unavailable", "memory_invalid"])("accepts %s only as an optional CPU cap skip with kernel custody still proven", diagnostic => {
    const report = vmTransferReport();
    const changed = { ...report, resources: { ...report.resources, cpuMax: "400000 100000", memoryMax: String(7 * gib), memoryBudget: { ...report.resources.memoryBudget,
      source: "fallback", capped: false }, cpuSplit: { ...report.resources.cpuSplit,
      workload: { controllers: ["cpu"], cpuWeight: 100, cap: { kind: "skipped", cpuMax: "max 100000", diagnostic } },
    } } };
    expect(verifyRuntimeTransferReport(changed, transferActive, transferResources))
      .toEqual(createHash("sha256").update(JSON.stringify(changed) + "\n").digest());
    const unboundedCpuParent = { ...changed, resources: { ...changed.resources, cpuMax: null, finite: false } };
    expect(verifyRuntimeTransferReport(unboundedCpuParent, transferActive, transferResources)).toBeNull();
    expect(verifyRuntimeTransferReport({ ...changed, qualification: { ...changed.qualification,
      execution: { ...changed.qualification.execution, vmWorkloadDrain: false } } }, transferActive, transferResources)).toBeNull();
    expect(verifyRuntimeTransferReport(changed, transferActive, { ...transferResources, cpuMillicores: 4000 })).toBeNull();
  });

  it("keeps archived finite v1 resources unchanged and requires honest v2 ancestor limits", () => {
    const report = vmTransferReport(), legacy = legacyTransferReport();
    expect(verifyRuntimeTransferReport(legacy, transferActive, transferResources)).not.toBeNull();
    expect(verifyRuntimeTransferReport({ ...legacy, resources: { ...legacy.resources,
      cpuSplit: report.resources.cpuSplit } }, transferActive, transferResources)).toBeNull();
    for (const changed of [
      { ...report.resources, cpuMax: "max 100000" },
      { ...report.resources, memoryMax: "max" },
      { ...report.resources, pidsMax: "max" },
      { ...report.resources, finite: false },
      { ...report.resources, cpuMax: undefined },
      { ...report.resources, memoryMax: null },
      { ...report.resources, pidsMax: null },
      { ...report.resources, memoryMax: undefined },
      { ...report.resources, pidsMax: undefined },
      { ...report.resources, cpuSplit: undefined },
    ]) expect(verifyRuntimeTransferReport({ ...report, resources: changed }, transferActive, transferResources)).toBeNull();
  });

  it("preserves actual nominal ancestor bounds and refuses inconsistent finite flags", () => {
    const report = vmTransferReport();
    for (const limits of [
      { cpuMax: "200000 100000", memoryMax: "3221225472", pidsMax: "4096", finite: true },
      { cpuMax: "200000 100000", memoryMax: "3221225472", pidsMax: "9223372036854775807", finite: true },
    ]) {
      const changed = { ...report, resources: { ...report.resources, ...limits } };
      expect(verifyRuntimeTransferReport(changed, transferActive, transferResources))
        .toEqual(createHash("sha256").update(JSON.stringify(changed) + "\n").digest());
      expect(verifyRuntimeTransferReport({ ...changed, resources: { ...changed.resources, finite: !limits.finite } }, transferActive, transferResources)).toBeNull();
    }
    for (const limits of [{ cpuMax: null, finite: false }, { cpuMax: "9223372036854775807 100000" }]) {
      expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources, ...limits } }, transferActive, transferResources)).toBeNull();
    }
    for (const field of ["cpuMillicores", "memoryMiB", "storageMiB"] as const) {
      expect(verifyRuntimeTransferReport(report, transferActive, { ...transferResources,
        [field]: transferResources[field] * 2 })).toBeNull();
    }
  });

  it("refuses malformed, unsafe or invented actual ancestor limits", () => {
    const report = vmTransferReport();
    for (const limits of [
      { memoryMax: "0" }, { memoryMax: "-1" }, { memoryMax: "9223372036854775808" },
      { memoryMax: null, pidsMax: null, cpuMax: null, finite: false },
      { pidsMax: "0" }, { pidsMax: 4096 }, { pidsMax: "4096\n" },
      { cpuMax: "0 100000" }, { cpuMax: "150000 0" }, { cpuMax: "1 9223372036854775808" },
      { cpuMax: "9223372036854775808 100000" }, { cpuMax: "max 100000" },
      { memoryMax: "4294967296", pidsMax: "4096", cpuMax: "200000 100000", finite: false },
    ]) expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources, ...limits } }, transferActive, transferResources)).toBeNull();
  });

  it("refuses contradictory engine or workload leaf resources", () => {
    const report = vmTransferReport(), split = report.resources.cpuSplit;
    for (const changed of [
      { ...split, engine: { ...split.engine, cpuMax: "200000 100000" } },
      { ...split, engine: { ...split.engine, cpuWeight: 101 } },
      { ...split, engine: { ...split.engine, memoryMax: "4294967296" } },
      { ...split, engine: { ...split.engine, pidsMax: "4096" } },
      { ...split, workload: { ...split.workload, cpuWeight: 0 } },
      { ...split, workload: { ...split.workload, controllers: [] } },
      { ...split, workload: { ...split.workload, controllers: ["cpu", "memory"] } },
      { ...split, workload: { ...split.workload, controllers: ["cpu", "pids"] } },
      { ...split, workload: { ...split.workload, memoryMax: "4294967296" } },
      { ...split, workload: { ...split.workload, pidsMax: "4096" } },
    ]) expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources, cpuSplit: changed } }, transferActive, transferResources)).toBeNull();
  });

  it("refuses malformed or mismatched caps and unbounded cap-skip diagnostics", () => {
    const report = vmTransferReport(), split = report.resources.cpuSplit, cap = split.workload.cap;
    for (const changed of [
      { ...cap, effectiveCpus: 0 }, { ...cap, effectiveCpus: 1.5 },
      { ...cap, effectiveCpus: 65537 }, { ...cap, effectiveCpus: "2" },
      { ...cap, effectiveCpus: Number.NaN }, { ...cap, effectiveCpus: Infinity },
      { ...cap, cpuMax: "150001 100000" }, { ...cap, cpuMax: "150000 100001" },
      { ...cap, cpuMax: "max 100000" }, { ...cap, diagnostic: "cpuset_unavailable" },
      { kind: "skipped", cpuMax: "150000 100000", diagnostic: "cpuset_unavailable" },
      { kind: "skipped", cpuMax: "max 100000" },
      { kind: "skipped", cpuMax: "max 100000", diagnostic: "EACCES:/sys/fs/cgroup/private" },
      { kind: "skipped", cpuMax: "max 100000", diagnostic: "cpuset_invalid", effectiveCpus: 2 },
    ]) expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources, cpuSplit: { ...split,
      workload: { ...split.workload, cap: changed } } } }, transferActive, transferResources)).toBeNull();
  });

  it.each(["originalProcessGroupsRetired", "timeoutRetired", "workloadCgroup", "vmWorkloadDrain"])("requires genuine %s proof independently of CPU availability", field => {
    const report = vmTransferReport(), execution = report.qualification.execution;
    const missing = Object.fromEntries(Object.entries(execution).filter(([key]) => key !== field));
    for (const changed of [missing, { ...execution, [field]: false }, { ...execution, [field]: "true" },
      { ...execution, detachedDescendantsRetired: true }]) {
      expect(verifyRuntimeTransferReport({ ...report, qualification: { ...report.qualification,
        execution: changed } }, transferActive, transferResources)).toBeNull();
    }
  });

  it.each(["secure", "unprivileged", "designProtection", "sameEngineIdentity"])("refuses new isolation claims: %s", field => {
    const report = vmTransferReport();
    expect(verifyRuntimeTransferReport({ ...report, qualification: { ...report.qualification, [field]: true } }, transferActive, transferResources)).toBeNull();
  });

  it("refuses missing/false lifecycle, foreign identities and unexpected worker helpers", () => {
    const report = vmTransferReport();
    for (const changed of [
      { ...report, boundary: "process" },
      { ...report, helpers: { ...report.helpers, trusted: { node: true, bwrap: true } } },
      { ...report, helpers: { ...report.helpers, deploymentTrusted: { ...report.helpers.deploymentTrusted, workerSupervisor: true } } },
      { ...report, qualification: { ...report.qualification, identity: { hostUid: 10001, namespaceUid: 0 } } },
      { ...report, qualification: { ...report.qualification, execution: { ...report.qualification.execution, timeoutRetired: false } } },
      { ...report, qualification: { ...report.qualification, execution: { ...report.qualification.execution, namespaceUid: 0 } } },
      { ...report, qualification: { ...report.qualification, execution: { ...report.qualification.execution, noSandbox: false } } },
      { ...report, qualification: { ...report.qualification, capture: { ...report.qualification.capture, namespaceUid: 0 } } },
      { ...report, qualification: { ...report.qualification, capture: { ...report.qualification.capture, chromiumSandbox: false } } },
      { ...report, qualification: { ...report.qualification, humanServices: { ...report.qualification.humanServices, hostUid: 10004 } } },
      { ...report, qualification: { ...report.qualification, actorTools: { ...report.qualification.actorTools, namespaceUid: 10003 } } },
      { ...report, setupQualification: { ...report.setupQualification, hostUid: 10001 } },
      { ...report, setupQualification: { ...report.setupQualification, detachedDescendantsRetired: false } },
    ]) expect(verifyRuntimeTransferReport(changed, transferActive, transferResources)).toBeNull();
  });

  it("requires non-root namespace identity, NNP/seccomp and every capability set empty",()=>{
    const report=vmTransferReport(), identity=report.qualification.identity;
    for(const field of Object.keys(identity.capabilities)) {
      expect(verifyRuntimeTransferReport({...report,qualification:{...report.qualification,identity:{...identity,
        capabilities:{...identity.capabilities,[field]:1}}}},transferActive,transferResources)).toBeNull();
    }
    for(const changed of [
      {...identity,namespaceUid:0}, {...identity,noNewPrivs:0}, {...identity,seccompMode:0},
      {...identity,capabilities:undefined}, {...identity,capabilities:{}},
      {...identity,capabilities:{...identity.capabilities,effective:"0"}},
      {...identity,capabilities:{...identity.capabilities,unexpected:0}},
    ])expect(verifyRuntimeTransferReport({...report,qualification:{...report.qualification,identity:changed}},transferActive,transferResources)).toBeNull();
  });

  it("retains exact runtime/controller binding, resource floors and the bounded report", () => {
    const report = vmTransferReport();
    for (const field of Object.keys(report.runtime)) {
      expect(verifyRuntimeTransferReport({ ...report, runtime: { ...report.runtime, [field]: "foreign" } }, transferActive, transferResources)).toBeNull();
    }
    expect(verifyRuntimeTransferReport(report, transferActive, { ...transferResources, memoryMiB: 8192 })).toBeNull();
    expect(verifyRuntimeTransferReport({ ...report, resources: { ...report.resources,
      allocation: { ...report.resources.allocation, retainedAllocationField: "x".repeat(128 * 1024) } } }, transferActive, transferResources)).toBeNull();
  });
});
