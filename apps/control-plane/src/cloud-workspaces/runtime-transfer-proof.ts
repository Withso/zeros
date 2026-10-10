import { createHash } from "node:crypto";
import { z } from "zod";
import { CloudRuntimeWitnessSchema, type CloudActiveRuntime } from "./runtime-contract.js";

const yes = z.literal(true);
const positive = z.number().int().positive().safe();
const limit = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value=>Number.isSafeInteger(Number(value)));
const all = (names: string[]) => z.object(Object.fromEntries(names.map(name=>[name,yes]))).strict();
// Archived attestation contract. Its sandbox fields stay reader-only.
const LegacyReport = z.object({ version:z.literal(1),profile:z.literal("zeros-cloud-worker-v4"),qualified:yes,
  runtime:CloudRuntimeWitnessSchema,
  helpers:z.object({ trusted:all(["node","bwrap","setpriv","supervisor"]),deploymentTrusted:all([
    "runtimeProfile","engineLauncher","engineView","engineCgroup","runtimeLayout","resourceInspector","resourceAdmission",
    "setupProcess","admissionConsumer","previewLinkInstaller","githubCredentialInstaller","githubRefreshRequestHelper","gitAskpass",
    "workerSupervisor","setupHelper","attester","engineNamespace","launcher","engineQualification","engineAppArmor","runtimeTree","admissionDirectory",
  ]) }).strict(),
  resources:z.object({finite:yes,cpuMax:z.string().regex(/^[1-9][0-9]{0,15} [1-9][0-9]{0,15}$/),memoryMax:limit,pidsMax:limit,
    allocation:z.object({cpuMillicores:positive,memoryBytes:positive,storageBytes:positive}).passthrough() }).strict(),
  qualification:z.object({secure:yes,identity:z.object({secure:yes,hostUid:z.literal(10003),namespaceUid:z.literal(0),
    noNewPrivs:z.literal(1),seccompMode:z.literal(2)}).strict(),workload:all(["secure"]),capture:all(["secure"]),
    humanServices:all(["secure"]),actorTools:all(["secure"]) }).strict(),
  setupQualification:all(["secure","unprivileged","detachedDescendantsRetired","timeoutRetired"]),
}).strict();

const maximumKernelLimit = 9223372036854775807n;
function isKernelLimit(value: string): boolean {
  return /^[1-9][0-9]{0,18}$/.exec(value)?.[0] === value && BigInt(value) <= maximumKernelLimit;
}
function isKernelCpuLimit(value: string): boolean {
  const parts = value.split(" ");
  return parts.length === 2 && parts.every(isKernelLimit);
}
const kernelLimit = z.string().refine(isKernelLimit);
const kernelCpuLimit = z.string().refine(isKernelCpuLimit);
const memoryBudget = z.object({
  nominalMemoryBytes: kernelLimit.nullable(), measuredMemoryBytes: kernelLimit.nullable(), hostMemoryMax: kernelLimit,
  source: z.enum(["nominal", "fallback"]), capped: z.boolean(),
}).strict();
const workloadCap = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("applied"), effectiveCpus: positive.max(65536),
    cpuMax: z.string().regex(/^[1-9][0-9]{0,15} 100000$/) }).strict(),
  z.object({ kind: z.literal("skipped"), cpuMax: z.literal("max 100000"),
    diagnostic: z.enum(["cpuset_unavailable", "cpuset_invalid", "memory_unavailable", "memory_invalid"]) }).strict(),
]);
const cpuSplit = z.object({
  engine: z.object({ cpuMax: z.literal("max 100000"), cpuWeight: z.literal(100) }).strict(),
  workload: z.object({ controllers: z.tuple([z.literal("cpu")]), cpuWeight: z.literal(100), cap: workloadCap }).strict(),
}).strict();
const VMResources = LegacyReport.shape.resources.extend({
  // These are measured ENGINE ancestors, never limits from the sibling host.
  // Main's existing memory/pids bounds remain on the common runtime parent.
  finite: z.boolean(), cpuMax: kernelCpuLimit.nullable(), memoryMax: kernelLimit, pidsMax: kernelLimit, cpuSplit, memoryBudget,
}).strict().refine(resources => resources.finite === (resources.cpuMax !== null))
  .refine(resources => {
    const budget = resources.memoryBudget, reserve = 1073741824n;
    // Nested scalar refinements can leave Zod's parse dirty while this parent
    // refinement still runs. Recheck every operand before BigInt conversion.
    if (!isKernelLimit(budget.hostMemoryMax) ||
      (budget.nominalMemoryBytes !== null && !isKernelLimit(budget.nominalMemoryBytes)) ||
      (budget.measuredMemoryBytes !== null && !isKernelLimit(budget.measuredMemoryBytes))) return false;
    const nominal = budget.nominalMemoryBytes === null ? null : BigInt(budget.nominalMemoryBytes);
    if (nominal !== null && nominal <= reserve) return false;
    const fallback = budget.source === "fallback";
    if (fallback !== (resources.cpuSplit.workload.cap.kind === "skipped")) return false;
    // The broker records the mode. Fallback reproduces main's constants even
    // when some raw observations are known; only nominal mode uses a host cap.
    if (fallback) return budget.capped === false && resources.cpuMax === "400000 100000" &&
      resources.memoryMax === "7516192768" && resources.pidsMax === "4096";
    if (nominal === null || budget.measuredMemoryBytes === null) return false;
    const target = nominal - reserve;
    const ceiling = BigInt(budget.measuredMemoryBytes) - BigInt(budget.hostMemoryMax);
    return ceiling > 0n && budget.capped === (ceiling < target) &&
      resources.memoryMax === String(ceiling < target ? ceiling : target);
  })
  .refine(resources => {
    const cap = resources.cpuSplit.workload.cap;
    if (cap.kind === "skipped") return true;
    if (!Number.isSafeInteger(cap.effectiveCpus) || cap.effectiveCpus < 1 || cap.effectiveCpus > 65536 ||
      (resources.cpuMax !== null && !isKernelCpuLimit(resources.cpuMax))) return false;
    const cpus = BigInt(cap.effectiveCpus);
    const [quota, period] = resources.cpuMax === null ? [cpus, 1n] : resources.cpuMax.split(" ").map(BigInt);
    if (quota === undefined || period === undefined) return false;
    const bounded = quota < cpus * period ? quota : cpus * period;
    // Exact positive rational rounding: 75% of min(cpuset, ancestor quota).
    const expectedQuota = (bounded * 75000n * 2n + period) / (period * 2n);
    return cap.cpuMax === `${expectedQuota} 100000`;
  });

// The VM is the boundary. These checks prove the pinned deployment and owned
// process retirement; they make no per-agent isolation or Design claims.
const VMReport = z.object({
  version: z.literal(2), profile: z.literal("zeros-cloud-worker-v4"), qualified: yes,
  boundary: z.literal("workspace-vm"), runtime: CloudRuntimeWitnessSchema,
  helpers: z.object({
    trusted: all(["node"]),
    deploymentTrusted: LegacyReport.shape.helpers.shape.deploymentTrusted
      .omit({ workerSupervisor: true }).extend({ hostProcessSupervisor: yes }).strict(),
  }).strict(),
  resources: VMResources,
  qualification: z.object({
    identity: z.object({ hostUid: z.literal(10003), namespaceUid: z.literal(10003),
      noNewPrivs: z.literal(1), seccompMode: z.literal(2), capabilities: z.object({
        effective:z.literal(0),permitted:z.literal(0),inheritable:z.literal(0),bounding:z.literal(0),ambient:z.literal(0),
      }).strict() }).strict(),
    // Conversation Stop/timeout proves ORIGINAL process groups only. The
    // separate shared-cgroup probe proves whole-VM workload drain, not Stop.
    execution: all(["sameEngineIdentity","noSandbox","ownedProcessGroups","originalProcessGroupsRetired",
      "timeoutRetired","workloadCgroup","vmWorkloadDrain"]),
    capture: all(["sameEngineIdentity","chromiumSandbox"]),
    humanServices: all(["sameEngineIdentity","noSandbox"]), actorTools: all(["sameEngineIdentity","noSandbox"]),
  }).strict(),
  setupQualification: z.object({ hostUid: z.literal(10003), hostGid: z.literal(10003),
    detachedDescendantsRetired: yes, timeoutRetired: yes }).strict(),
}).strict();
const Report = z.union([LegacyReport, VMReport]);

/** Only the fixed pinned-root installer conversation may supply this report.
 * Its execution fence/session provides freshness; a report from an ordinary
 * engine request is not attestation. Persist its digest, never raw diagnostics. */
export function verifyRuntimeTransferReport(report: unknown, active: CloudActiveRuntime,
  resources: { cpuMillicores: number; memoryMiB: number; storageMiB: number }): Buffer | null {
  const parsed = Report.safeParse(report);
  if (!parsed.success || !Object.entries(parsed.data.runtime).every(([key,value])=>active[key as keyof CloudActiveRuntime]===value)) return null;
  const allocation = parsed.data.resources.allocation;
  const expectedMemory = resources.memoryMiB * 1024 * 1024, expectedStorage = resources.storageMiB * 1024 * 1024;
  // MemTotal and formatted storage exclude kernel/filesystem reservations.
  // Current runtime admission permits 6% accounting overhead; v1 is exact.
  const current = parsed.data.version === 2;
  if (current && (!Number.isSafeInteger(resources.cpuMillicores) || resources.cpuMillicores <= 0 ||
    !Number.isSafeInteger(expectedMemory) || expectedMemory <= 0 ||
    !Number.isSafeInteger(expectedStorage) || expectedStorage <= 0)) return null;
  if (allocation.cpuMillicores < resources.cpuMillicores ||
    allocation.memoryBytes < (current ? Math.floor(expectedMemory * 0.94) : expectedMemory) ||
    allocation.storageBytes < (current ? Math.floor(expectedStorage * 0.94) : expectedStorage)) return null;
  if (parsed.data.version === 2) {
    const budget = parsed.data.resources.memoryBudget;
    if ((budget.nominalMemoryBytes !== null && budget.nominalMemoryBytes !== String(expectedMemory)) ||
      (budget.measuredMemoryBytes !== null && BigInt(budget.measuredMemoryBytes) < BigInt(allocation.memoryBytes))) return null;
    if (budget.source === "nominal") {
      const cpuMax = parsed.data.resources.cpuMax;
      if (cpuMax === null || BigInt(parsed.data.resources.memoryMax) > BigInt(expectedMemory)) return null;
      if (cpuMax !== `${BigInt(resources.cpuMillicores) * 100n} 100000`) return null;
    }
  }
  const serialized = JSON.stringify(report)+"\n";
  return Buffer.byteLength(serialized)<=128*1024 ? createHash("sha256").update(serialized).digest() : null;
}
