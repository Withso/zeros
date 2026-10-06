import { createHash } from "node:crypto";
import { z } from "zod";
import { CloudRuntimeWitnessSchema, type CloudActiveRuntime } from "./runtime-contract.js";

const yes = z.literal(true);
const positive = z.number().int().positive().safe();
const limit = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value=>Number.isSafeInteger(Number(value)));
const all = (names: string[]) => z.object(Object.fromEntries(names.map(name=>[name,yes]))).strict();
const Report = z.object({ version:z.literal(1),profile:z.literal("zeros-cloud-worker-v4"),qualified:yes,
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

/** Only the fixed pinned-root installer conversation may supply this report.
 * Its execution fence/session provides freshness; a report from an ordinary
 * engine request is not attestation. Persist its digest, never raw diagnostics. */
export function verifyRuntimeTransferReport(report: unknown, active: CloudActiveRuntime,
  resources: { cpuMillicores: number; memoryMiB: number; storageMiB: number }): Buffer | null {
  const parsed = Report.safeParse(report);
  if (!parsed.success || !Object.entries(parsed.data.runtime).every(([key,value])=>active[key as keyof CloudActiveRuntime]===value)) return null;
  const allocation = parsed.data.resources.allocation;
  if (allocation.cpuMillicores<resources.cpuMillicores || allocation.memoryBytes<resources.memoryMiB*1024*1024 ||
    allocation.storageBytes<resources.storageMiB*1024*1024) return null;
  const serialized = JSON.stringify(report)+"\n";
  return Buffer.byteLength(serialized)<=128*1024 ? createHash("sha256").update(serialized).digest() : null;
}
