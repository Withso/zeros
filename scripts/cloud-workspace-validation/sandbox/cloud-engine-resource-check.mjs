import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveCloudRuntime } from "./cloud-runtime-root.mjs";
import { effectiveCloudResourceLimits } from "./cgroup-resources.mjs";
import { cloudRuntimeResourcesQualified, validCloudResourceBudgetProjection } from "./cloud-resource-admission.mjs";
import { readCloudResourceBudgetProjection } from "./cloud-resource-budget.mjs";
import { loadCloudWorkloadCustody, nativeCloudWorkloadIO } from "../../../apps/desktop/src/engine/agents/containment/cloud-workload-cgroup.mjs";

function optional(file) {
  try { return readFileSync(file, "utf8").trim(); }
  catch { return null; }
}

/** Actual root-projected controller and kernel controls, not caller-selected
 * cgroup paths. The explicit IO seam is used only by portable unit fixtures. */
export function qualifyCloudEngineResources(runtime = resolveCloudRuntime(), io = nativeCloudWorkloadIO, read = optional) {
  const custody = loadCloudWorkloadCustody(runtime.cgroupRoot, io);
  const controller = custody.infrastructure.find(birth => birth.pid === io.identity().pid && birth.controlDirectory);
  const projection = readCloudResourceBudgetProjection();
  if (!validCloudResourceBudgetProjection(projection)) throw new Error("Cloud engine resource qualification failed");
  const resources = { ...effectiveCloudResourceLimits(read("/proc/self/cgroup"), read), cpuSplit: custody.cpuSplit,
    memoryBudget: projection.memoryBudget };
  if (!controller || `/sys/fs/cgroup${resources.hierarchy[0]?.path}` !== controller.controlDirectory ||
      !cloudRuntimeResourcesQualified(resources) || resources.memoryBudget.source === "nominal" &&
      resources.cpuMax !== `${projection.resources.cpuMillicores * 100} 100000`)
    throw new Error("Cloud engine resource qualification failed");
  for (const original of [custody.common, custody.workload]) {
    const current = io.directory(original.directory);
    if (current.dev !== original.dev || current.ino !== original.ino || current.uid !== 10003 || current.filesystem !== 0x63677270 || current.mode & 0o022)
      throw new Error("Cloud engine resource qualification failed");
  }
  const controlled = (directory, name, expected) => {
    const metadata = io.control(directory, name);
    if (![0, 65534].includes(metadata.uid) || metadata.mode & 0o022 || metadata.filesystem !== 0x63677270 || io.read(directory, name).trim() !== expected)
      throw new Error("Cloud engine resource qualification failed");
  };
  controlled(controller.controlDirectory, "cpu.max", resources.cpuSplit.engine.cpuMax);
  controlled(controller.controlDirectory, "cpu.weight", "100");
  controlled(custody.workload.directory, "cpu.max", resources.cpuSplit.workload.cap.cpuMax);
  controlled(custody.workload.directory, "cpu.weight", "100");
  controlled(`${runtime.cgroupRoot}/host`, "memory.max", resources.memoryBudget.hostMemoryMax);
  const meminfo = read("/proc/meminfo");
  const lines = typeof meminfo === "string" && meminfo.length <= 65536 ? meminfo.split("\n").filter(line => line.startsWith("MemTotal:")) : [];
  const match = lines.length === 1 && /^MemTotal:\s+([1-9][0-9]{0,15}) kB$/.exec(lines[0]);
  const measured = match ? BigInt(match[1]) * 1024n : null;
  if (resources.memoryBudget.measuredMemoryBytes !== null && measured !== BigInt(resources.memoryBudget.measuredMemoryBytes) ||
      resources.memoryBudget.source === "nominal" && measured !== null &&
      BigInt(resources.memoryMax) > measured - BigInt(resources.memoryBudget.hostMemoryMax))
    throw new Error("Cloud engine resource qualification failed");
  if ([custody.common.directory, path.dirname(custody.workload.directory)]
    .some(directory => io.read(directory, "cgroup.subtree_control").trim() !== "cpu")) throw new Error("Cloud engine resource qualification failed");
  return resources;
}
