import { expect, it, vi } from "vitest";
import { CLOUD_ENGINE_LIMITS, CLOUD_RUNTIME_LIMITS, cloudRuntimeBudget, cloudWorkloadCpuCap } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
const engine = "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime/engine-32345678-1234-4234-8234-123456789abc";
it.each([["0", 1, "75000 100000"], ["0-1", 2, "150000 100000"], ["0-3", 4, "300000 100000"], ["0-7", 8, "600000 100000"], ["0-15", 16, "1200000 100000"], ["0-3,6", 5, "375000 100000"]])(
  "caps the shared workload at75%% of effective CPU set %s", (source, count, max) => {
    expect(cloudWorkloadCpuCap(engine, () => source)).toEqual({ kind: "applied", effectiveCpus: count, cpuMax: max });
  });
it("walks only exact engine ancestry when a cpu-only leaf has no cpuset file", () => {
  const read = vi.fn((file: string) => { if (file !== "/sys/fs/cgroup/cpuset.cpus.effective") throw Object.assign(new Error(), { code: "ENOENT" }); return "0-7\n"; });
  expect(cloudWorkloadCpuCap(engine, read)).toEqual({ kind: "applied", effectiveCpus: 8, cpuMax: "600000 100000" });
  expect(read.mock.calls.map(([file]) => file)).toEqual([
    `${engine}/cpuset.cpus.effective`, "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime/cpuset.cpus.effective", "/sys/fs/cgroup/system.slice/zeros-host.service/cpuset.cpus.effective",
    "/sys/fs/cgroup/system.slice/cpuset.cpus.effective", "/sys/fs/cgroup/cpuset.cpus.effective",
  ]);
});
it.each(["", "-1", "3-1", "0-3,3", "0,,2", "0-3 private", "65536"])("keeps custody uncapped with a closed diagnostic for malformed %j", source => {
  expect(cloudWorkloadCpuCap(engine, () => source)).toEqual({ kind: "skipped", cpuMax: "max 100000", diagnostic: "cpuset_invalid" });
});
it.each(["ENOENT", "EACCES"])("does not fail mandatory custody when CPU set is unreadable (%s)", code => {
  const read = vi.fn(() => { throw Object.assign(new Error("private path/error"), { code }); });
  expect(cloudWorkloadCpuCap(engine, read)).toEqual({ kind: "skipped", cpuMax: "max 100000", diagnostic: "cpuset_unavailable" });
  if (code === "EACCES") expect(read).toHaveBeenCalledTimes(1);
});
it("keeps the engine uncapped with weight100 and no added memory/pids limit", () => {
  expect(CLOUD_ENGINE_LIMITS).toEqual({ "cpu.max": "max 100000", "cpu.weight": "100" });
});
it.each([1, 2, 4, 8, 16])("honors actual inherited parent quota for a %iCPU allocation", cpus => {
  const source = cpus === 1 ? "0" : `0-${cpus - 1}`;
  expect(cloudWorkloadCpuCap(engine, () => source, "400000 100000").cpuMax).toBe(`${Math.min(cpus, 4) * 75000} 100000`);
});
it("rounds fractional actual ancestor quota with bounded integer arithmetic", () => {
  expect(cloudWorkloadCpuCap(engine, () => "0-7", "100001 300000").cpuMax).toBe("25000 100000");
});
it.each([1, 2, 4, 8, 16])("scales the common parent and cap to %i verified CPUs", cpus => {
  const result = cloudRuntimeBudget(engine, file => file.endsWith("cpuset.cpus.effective") ? (cpus === 1 ? "0" : `0-${cpus - 1}`) : "MemTotal: 8388608 kB\n", undefined, 8 * 1024 ** 3, 256 * 1024 ** 2, cpus * 1000);
  expect(result.limits).toEqual({ ...CLOUD_RUNTIME_LIMITS, "cpu.max": `${cpus * 100000} 100000` });
  expect(result.cap).toEqual({ kind: "applied", effectiveCpus: cpus, cpuMax: `${cpus * 75000} 100000` });
});
it.each([4, 8, 16])("scales the parent from the same %iGiB MemTotal allocation as SKU admission", gib => {
  const result = cloudRuntimeBudget(engine, file => file.endsWith("cpuset.cpus.effective") ? "0-3" : `MemTotal: ${gib * 1024 * 1024} kB\n`, undefined, gib * 1024 ** 3, 256 * 1024 ** 2, 4000);
  expect(result.limits["memory.max"]).toBe(String((gib - 1) * 1024 ** 3));
  expect(result.limits["pids.max"]).toBe("4096");
  expect(result.limits["memory.oom.group"]).toBe("1");
});
it("retains main's exact default CPU/memory/pids budget byte-for-byte", () => {
  expect(CLOUD_RUNTIME_LIMITS).toEqual({ "cpu.max": "400000 100000", "memory.max": "7516192768", "pids.max": "4096", "memory.oom.group": "1" });
  expect(cloudRuntimeBudget(engine, file => file.endsWith("cpuset.cpus.effective") ? "0-3" : "MemTotal: 8388608 kB\n").limits).toEqual(CLOUD_RUNTIME_LIMITS);
});
it.each(["", "MemTotal: private kB", "MemTotal: 8388608 kB\nMemTotal: 8388608 kB"])("keeps the exact default budget and skips only the cap for invalid memory %j", source => {
  const result = cloudRuntimeBudget(engine, file => file.endsWith("cpuset.cpus.effective") ? "0-15" : source);
  expect(result.limits).toEqual(CLOUD_RUNTIME_LIMITS);
  expect(result.cap).toEqual({ kind: "skipped", cpuMax: "max 100000", diagnostic: "memory_invalid" });
});
it("keeps the default budget and an uncapped workload when memory evidence is unreadable", () => {
  const result = cloudRuntimeBudget(engine, file => { if (file.endsWith("cpuset.cpus.effective")) return "0-15"; throw Object.assign(new Error("private path"), { code: "EACCES" }); });
  expect(result.limits).toEqual(CLOUD_RUNTIME_LIMITS);
  expect(result.cap).toEqual({ kind: "skipped", cpuMax: "max 100000", diagnostic: "memory_unavailable" });
});
it("uses both exact main defaults if either required measurement is unavailable", () => {
  const result = cloudRuntimeBudget(engine, file => { if (file.endsWith("cpuset.cpus.effective")) throw Object.assign(new Error(), { code: "ENOENT" }); return "MemTotal: 16777216 kB\n"; });
  expect(result.limits).toEqual(CLOUD_RUNTIME_LIMITS);
  expect(result.cap).toEqual({ kind: "skipped", cpuMax: "max 100000", diagnostic: "cpuset_unavailable" });
});
it.each([[4, 0.98], [8, 0.98], [16, 0.98], [8, 8131788 / 8388608]])(
  "uses the admitted nominal %iGiB budget despite normal kernel accounting overhead", (gib, ratio) => {
    const nominal = gib * 1024 ** 3, measured = Math.floor(nominal * ratio / 1024) * 1024;
    const result = cloudRuntimeBudget(engine, () => "0-3", measured, nominal, 256 * 1024 ** 2, 4000);
    expect(result.limits["memory.max"]).toBe(String(nominal - 1024 ** 3));
    expect(result.memoryBudget).toEqual({ nominalMemoryBytes: String(nominal), measuredMemoryBytes: String(measured),
      hostMemoryMax: String(256 * 1024 ** 2), source: "nominal", capped: false });
  });
it("caps the nominal budget at actual measured memory less the protected host limit", () => {
  const measured = 7300 * 1024 ** 2, nominal = 8 * 1024 ** 3, reserve = 512 * 1024 ** 2;
  const result = cloudRuntimeBudget(engine, () => "0-3", measured, nominal, reserve, 4000);
  expect(result.limits["memory.max"]).toBe(String(measured - reserve));
  expect(result.memoryBudget).toMatchObject({ source: "nominal", capped: true });
});
it.each([8, 16])("keeps exact main fallback on a valid %iCPU SKU, retaining known smaller memory honestly", cpus => {
  const measured = 4 * 1024 ** 3, nominal = 8 * 1024 ** 3;
  const result = cloudRuntimeBudget(engine, () => { throw Object.assign(new Error(), { code: "EACCES" }); },
    measured, nominal, 256 * 1024 ** 2, cpus * 1000);
  expect(result.limits).toEqual(CLOUD_RUNTIME_LIMITS);
  expect(result.memoryBudget).toEqual({ nominalMemoryBytes: String(nominal), measuredMemoryBytes: String(measured),
    hostMemoryMax: String(256 * 1024 ** 2), source: "fallback", capped: false });
  expect(result.cap).toEqual({ kind: "skipped", cpuMax: "max 100000", diagnostic: "cpuset_unavailable" });
});
it("uses the admitted nominal CPU bound rather than a larger measured cpuset", () => {
  const result = cloudRuntimeBudget(engine, () => "0-15", 8 * 1024 ** 3, 8 * 1024 ** 3, 256 * 1024 ** 2, 4000);
  expect(result.limits["cpu.max"]).toBe("400000 100000");
  expect(result.memoryBudget.source).toBe("nominal");
});
it("does not invent nominal CPU authority from a measurement when the admitted allocation is absent", () => {
  const result = cloudRuntimeBudget(engine, () => "0-15", 8 * 1024 ** 3, 8 * 1024 ** 3);
  expect(result.limits).toEqual(CLOUD_RUNTIME_LIMITS);
  expect(result.memoryBudget.source).toBe("fallback");
  expect(result.cap.kind).toBe("skipped");
});
