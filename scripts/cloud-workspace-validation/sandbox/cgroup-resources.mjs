import path from "node:path";

const MAX_LIMIT = 9223372036854775807n;

function positiveLimit(source) {
  if (!/^[1-9][0-9]{0,18}$/.test(source))
    throw new Error("Invalid cgroup limit");
  const value = BigInt(source);
  if (value > MAX_LIMIT) throw new Error("Invalid cgroup limit");
  return value;
}

function minimumLimit(previous, source) {
  if (source === null) return previous;
  const value = source.trim();
  if (value === "max") return previous;
  const limit = positiveLimit(value);
  return previous === null || limit < previous ? limit : previous;
}

/** The kernel enforces every ancestor, not just the process scope. VM roots
 * may be unlimited; container roots often carry the provider's actual quota.
 * Missing or unlimited bounds never become an invented successful limit. */
export function effectiveCloudResourceLimits(membership, readOptional) {
  if (typeof membership !== "string" || membership.length > 8192)
    throw new Error("Invalid cgroup membership");
  const entries = membership
    .split("\n")
    .filter((line) => line.startsWith("0::"));
  const relative = entries[0]?.slice(3);
  if (
    entries.length !== 1 ||
    !relative?.startsWith("/") ||
    relative.includes("\0") ||
    /[\r\n]/.test(relative) ||
    path.posix.normalize(relative) !== relative ||
    relative.split("/").length > 128
  )
    throw new Error("Invalid cgroup v2 membership");
  let cursor = relative;
  let memory = null;
  let pids = null;
  let cpu = null;
  const hierarchy = [];
  for (;;) {
    const directory = path.posix.join("/sys/fs/cgroup", cursor);
    const memoryMax = readOptional(path.join(directory, "memory.max"));
    const pidsMax = readOptional(path.join(directory, "pids.max"));
    const cpuMax = readOptional(path.join(directory, "cpu.max"));
    memory = minimumLimit(memory, memoryMax);
    pids = minimumLimit(pids, pidsMax);
    if (cpuMax !== null) {
      const match = /^(max|[1-9][0-9]{0,18}) ([1-9][0-9]{0,18})$/.exec(
        cpuMax.trim(),
      );
      if (!match) throw new Error("Invalid CPU cgroup limit");
      const period = positiveLimit(match[2]);
      if (match[1] !== "max") {
        const quota = positiveLimit(match[1]);
        if (cpu === null || quota * cpu.period < cpu.quota * period)
          cpu = { quota, period };
      }
    }
    hierarchy.push({ path: cursor, memoryMax, cpuMax, pidsMax });
    if (cursor === "/") break;
    cursor = path.posix.dirname(cursor);
  }
  return {
    memoryMax: memory?.toString() ?? null,
    cpuMax: cpu ? `${cpu.quota} ${cpu.period}` : null,
    pidsMax: pids?.toString() ?? null,
    finite: memory !== null && cpu !== null && pids !== null,
    hierarchy,
  };
}
