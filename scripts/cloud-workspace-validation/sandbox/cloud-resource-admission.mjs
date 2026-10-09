import { effectiveCloudResourceLimits } from "./cgroup-resources.mjs";
const MIB = 1024 * 1024;
export function cloudAllocationCapacity({
  isolated,
  membership,
  read,
  architecture,
  availableCPUs,
  storageBytes,
}) {
  // V2 places the engine in /sys/fs/cgroup/zeros-cloud-engine. Bootstrap may
  // run inside a smaller provider command scope which is not its parent.
  // A container provider's root quota remains visible and must still apply.
  const limits = effectiveCloudResourceLimits(
    isolated ? "0::/\n" : membership,
    read,
  );
  const quota = limits.cpuMax?.split(" ").map(Number);
  const physicalMemory =
    Number(
      /^MemTotal:\s+([0-9]+) kB$/m.exec(read("/proc/meminfo") ?? "")?.[1],
    ) * 1024;
  return {
    architecture:
      architecture === "x64"
        ? "linux/amd64"
        : architecture === "arm64"
          ? "linux/arm64"
          : null,
    cpuMillicores: Math.floor(
      Math.min(
        availableCPUs * 1000,
        quota ? (quota[0] / quota[1]) * 1000 : Infinity,
      ),
    ),
    memoryBytes: Math.min(
      physicalMemory,
      limits.memoryMax ? Number(limits.memoryMax) : Infinity,
    ),
    storageBytes,
  };
}
export function cloudImageReferenceMatchesBuild(reference, sha256) {
  if (typeof reference !== "string") return false;
  if (!reference.startsWith("boat:")) return true;
  const match = /^boat:([a-z0-9][a-z0-9-]{0,62})@sha256:([a-f0-9]{64})$/.exec(
    reference,
  );
  return match !== null && match[2] === sha256;
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validCloudResourceContract(value) {
  return (
    record(value) &&
    Object.keys(value).sort().join(",") ===
      "architecture,cpuMillicores,memoryMiB,storageMiB" &&
    ["linux/amd64", "linux/arm64"].includes(value.architecture) &&
    [value.cpuMillicores, value.memoryMiB, value.storageMiB].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647,
    )
  );
}
function limit(value) {
  return typeof value === "string" &&
    /^[1-9][0-9]{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;
}

function exactKeys(value, names) {
  return record(value) && Object.keys(value).sort().join(",") === [...names].sort().join(",");
}
function kernelLimit(value) {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}
function kernelCpuLimit(value) {
  return typeof value === "string" && value.split(" ").length === 2 && value.split(" ").every(kernelLimit);
}

/** Recompute the broker's explicit whole-parent policy without inventing a
 * measurement. Nominal mode uses the SKU/host ceiling; fallback reproduces
 * main's constants even when some genuine measurements remain available. */
export function cloudRuntimeMemoryLimit(budget) {
  if (!exactKeys(budget, ["nominalMemoryBytes", "measuredMemoryBytes", "hostMemoryMax", "source", "capped"]) ||
      !kernelLimit(budget.hostMemoryMax) || typeof budget.capped !== "boolean" ||
      !(budget.nominalMemoryBytes === null || kernelLimit(budget.nominalMemoryBytes))) return null;
  const reserve = 1073741824n;
  if (budget.nominalMemoryBytes !== null && BigInt(budget.nominalMemoryBytes) <= reserve) return null;
  if (!["nominal", "fallback"].includes(budget.source) ||
      !(budget.measuredMemoryBytes === null || kernelLimit(budget.measuredMemoryBytes))) return null;
  if (budget.source === "nominal" && (budget.nominalMemoryBytes === null || budget.measuredMemoryBytes === null)) return null;
  if (budget.source === "fallback") return budget.capped === false ? String(7n * reserve) : null;
  const target = BigInt(budget.nominalMemoryBytes) - reserve;
  const ceiling = BigInt(budget.measuredMemoryBytes) - BigInt(budget.hostMemoryMax);
  if (ceiling <= 0n || budget.capped !== (ceiling < target)) return null;
  return String(ceiling < target ? ceiling : target);
}

/** Strict nonsecret projection of the root's admitted SKU and applied budget.
 * Reading/trusting its deployment inode is the caller's separate obligation. */
export function validCloudResourceBudgetProjection(value) {
  return exactKeys(value, ["version", "resources", "memoryBudget"]) && value.version === 1 &&
    (value.resources === null || validCloudResourceContract(value.resources)) &&
    cloudRuntimeMemoryLimit(value.memoryBudget) !== null &&
    value.memoryBudget.nominalMemoryBytes === (value.resources === null ? null : String(value.resources.memoryMiB * MIB));
}

/** Validate the v2 observed common-parent bounds and CPU-only split. This
 * checks a report's consistency, never kernel custody or whole-tree drain. */
export function cloudRuntimeResourcesQualified(value) {
  if (!record(value) || !kernelLimit(value.memoryMax) || !kernelLimit(value.pidsMax) ||
      !(value.cpuMax === null || kernelCpuLimit(value.cpuMax)) || value.finite !== (value.cpuMax !== null) ||
      cloudRuntimeMemoryLimit(value.memoryBudget) !== value.memoryMax) return false;
  const split = value.cpuSplit;
  if (!exactKeys(split, ["engine", "workload"]) || !exactKeys(split.engine, ["cpuMax", "cpuWeight"]) ||
      split.engine.cpuMax !== "max 100000" || split.engine.cpuWeight !== 100 ||
      !exactKeys(split.workload, ["controllers", "cpuWeight", "cap"]) || split.workload.cpuWeight !== 100 ||
      !Array.isArray(split.workload.controllers) || split.workload.controllers.length !== 1 || split.workload.controllers[0] !== "cpu") return false;
  const cap = split.workload.cap;
  if (cap?.kind === "skipped") return value.memoryBudget.source === "fallback" &&
    value.finite === true && value.cpuMax === "400000 100000" && value.pidsMax === "4096" &&
    exactKeys(cap, ["kind", "cpuMax", "diagnostic"]) && cap.cpuMax === "max 100000" &&
    ["cpuset_unavailable", "cpuset_invalid", "memory_unavailable", "memory_invalid"].includes(cap.diagnostic);
  if (value.memoryBudget.source !== "nominal" || !exactKeys(cap, ["kind", "effectiveCpus", "cpuMax"]) || cap.kind !== "applied" ||
      !Number.isSafeInteger(cap.effectiveCpus) || cap.effectiveCpus < 1 || cap.effectiveCpus > 65536) return false;
  const cpus = BigInt(cap.effectiveCpus);
  const [quota, period] = value.cpuMax === null ? [cpus, 1n] : value.cpuMax.split(" ").map(BigInt);
  const bounded = quota < cpus * period ? quota : cpus * period;
  const expected = (bounded * 75000n * 2n + period) / (period * 2n);
  return expected > 0n && cap.cpuMax === `${expected} 100000`;
}

/** Compare the admitted generation against measured allocation AND tenant
 * limits. MemTotal excludes kernel reservations and a formatted disk excludes
 * filesystem metadata: permit 6% accounting overhead, never a smaller SKU.
 * V2 uses admitted nominal RAM minus 1 GiB, capped by measured RAM minus the
 * actual host limit. Its broker-assigned fallback stays main's exact bounds,
 * independently of the SKU, while measured allocation must still suffice.
 * The archived v1 floor reserves at most 1 GiB (25% on smaller profiles).
 * statfs measures usable filesystem capacity, not a provider's billing quota. */
export function cloudResourcesMeetContract(expected, measured) {
  const current = record(measured) && Object.hasOwn(measured, "cpuSplit");
  if (
    !validCloudResourceContract(expected) ||
    !record(measured) ||
    !record(measured.allocation) ||
    (current ? !cloudRuntimeResourcesQualified(measured) : measured.finite !== true)
  )
    return false;
  const allocation = measured.allocation;
  if (allocation.architecture !== expected.architecture) return false;
  const cpuMatch =
    typeof measured.cpuMax === "string" &&
    /^([1-9][0-9]{0,15}) ([1-9][0-9]{0,15})$/.exec(measured.cpuMax);
  const cpu = cpuMatch && (Number(cpuMatch[1]) / Number(cpuMatch[2])) * 1000;
  const memory = current ? BigInt(measured.memoryMax) : limit(measured.memoryMax);
  const expectedMemory = expected.memoryMiB * MIB;
  const minimumMemory =
    expectedMemory - Math.min(1024 * MIB, expectedMemory * 0.25);
  return (
    [
      allocation.cpuMillicores,
      allocation.memoryBytes,
      allocation.storageBytes,
    ].every((n) => Number.isSafeInteger(n) && n > 0) &&
    allocation.cpuMillicores >= expected.cpuMillicores &&
    allocation.memoryBytes >= Math.floor(expectedMemory * 0.94) &&
    allocation.storageBytes >= Math.floor(expected.storageMiB * MIB * 0.94) &&
    (current ? measured.memoryBudget.source === "fallback" ||
      measured.cpuMax === `${expected.cpuMillicores * 100} 100000`
      : Number.isFinite(cpu) && Math.abs(cpu - expected.cpuMillicores) < 0.001) &&
    memory !== null &&
    (current ? (measured.memoryBudget.nominalMemoryBytes === null ||
      measured.memoryBudget.nominalMemoryBytes === String(expectedMemory)) &&
      (measured.memoryBudget.measuredMemoryBytes === null ||
        BigInt(allocation.memoryBytes) <= BigInt(measured.memoryBudget.measuredMemoryBytes))
      : memory >= minimumMemory) &&
    (current && measured.memoryBudget.source === "fallback" || memory <= expectedMemory)
  );
}
