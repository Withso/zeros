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

/** Compare the admitted generation against measured allocation AND tenant
 * limits. MemTotal excludes kernel reservations and a formatted disk excludes
 * filesystem metadata: permit 6% accounting overhead, never a smaller SKU.
 * The engine reserves at most 1 GiB for VM services (25% on smaller profiles).
 * statfs measures usable filesystem capacity, not a provider's billing quota. */
export function cloudResourcesMeetContract(expected, measured) {
  if (
    !validCloudResourceContract(expected) ||
    !record(measured) ||
    !record(measured.allocation) ||
    measured.finite !== true
  )
    return false;
  const allocation = measured.allocation;
  if (allocation.architecture !== expected.architecture) return false;
  const cpuMatch =
    typeof measured.cpuMax === "string" &&
    /^([1-9][0-9]{0,15}) ([1-9][0-9]{0,15})$/.exec(measured.cpuMax);
  const cpu = cpuMatch && (Number(cpuMatch[1]) / Number(cpuMatch[2])) * 1000;
  const memory = limit(measured.memoryMax);
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
    Number.isFinite(cpu) &&
    Math.abs(cpu - expected.cpuMillicores) < 0.001 &&
    memory !== null &&
    memory >= minimumMemory &&
    memory <= expectedMemory
  );
}
