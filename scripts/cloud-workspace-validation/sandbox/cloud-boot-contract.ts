// Bundled separately for the fixed root helper. Never load the functional
// qualification graph (or a TypeScript transform worker) on the short path.
import { createHash } from "node:crypto";
import { z } from "zod";
import { CloudComputerQualificationSelectionSchema } from "../../../packages/protocol/src/cloud-build-qualification";
import { cloudRuntimeResourcesQualified } from "./cloud-resource-admission.mjs";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const positive = z.number().int().positive().safe();
const ticks = z.string().regex(/^[0-9]{1,32}$/);
const decimal = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/);
const inode = z.string().regex(/^[1-9][0-9]{0,19}$/);
const witness = z.object({ runtimeId: z.string().regex(/^r1-[a-f0-9]{64}$/), manifestSha256: hash,
  baseCompatibilityId: z.string().regex(/^bc1-[a-f0-9]{64}$/), installerReceiptSha256: hash,
  bootId: uuid, supervisorSessionId: uuid }).strict();
export const CloudBootWitnessSchema = witness.refine(value => value.runtimeId === `r1-${value.manifestSha256}`);
export const CloudBootAttemptSchema = z.object({ execution: z.object({ organizationId: uuid, workspaceId: uuid,
  generation: positive, setupRunId: uuid, executionFence: positive }).strict(), phase: z.enum(["preflight", "launch"]), nonce: hash }).strict();
export const CloudBuildVerificationSchema = z.object({ schema: z.literal("zeros.computer-build-verification/v1"),
  qualificationId: uuid, evidenceSha256: hash, bootIntegritySha256: hash, kernelSha256: hash, runtime: CloudBootWitnessSchema }).strict();
const scope = z.object({ directory: z.string().regex(/^\/sys\/fs\/cgroup\/system\.slice\/zeros-host\.service\/engine-runtime(?:\/[a-z0-9-]+)*$/),
  dev: decimal, ino: inode }).strict();
const cpu = z.string().regex(/^(?:max|[1-9][0-9]{0,18}) [1-9][0-9]{0,18}$/);
const limit = z.string().regex(/^[1-9][0-9]{0,18}$/);
const resources = z.object({ memoryMax: limit, cpuMax: cpu, pidsMax: limit, finite: z.literal(true),
  hierarchy: z.array(z.object({ path: z.string().max(4096), memoryMax: z.string().nullable(), cpuMax: z.string().nullable(),
    pidsMax: z.string().nullable() }).strict()).min(1).max(128),
  memoryBudget: z.object({ nominalMemoryBytes: limit.nullable(), measuredMemoryBytes: limit.nullable(), hostMemoryMax: limit,
    source: z.enum(["nominal", "fallback"]), capped: z.boolean() }).strict(),
  cpuSplit: z.object({ engine: z.object({ cpuMax: z.literal("max 100000"), cpuWeight: z.literal(100) }).strict(),
    workload: z.object({ controllers: z.tuple([z.literal("cpu")]), cpuWeight: z.literal(100), cap: z.union([
      z.object({ kind: z.literal("applied"), effectiveCpus: positive.max(65536), cpuMax: cpu }).strict(),
      z.object({ kind: z.literal("skipped"), cpuMax: z.literal("max 100000"), diagnostic: z.enum([
        "cpuset_unavailable", "cpuset_invalid", "memory_unavailable", "memory_invalid"]) }).strict(),
    ]) }).strict() }).strict(),
}).strict().refine(cloudRuntimeResourcesQualified);
export const CloudBootInnerProbeSchema = z.object({ schema: z.literal("zeros.cloud-boot-probe/v1"),
  identity: z.object({ uid: z.literal(10003), euid: z.literal(10003), gid: z.literal(10003), egid: z.literal(10003),
    uidMap: z.literal("10003 10003 1"), gidMap: z.literal("10003 10003 1"), noNewPrivs: z.literal(1), seccompMode: z.literal(2),
    capabilities: z.object({ effective: z.literal(0), permitted: z.literal(0), inheritable: z.literal(0),
      bounding: z.literal(0), ambient: z.literal(0) }).strict() }).strict(),
  // This runtime supports the current qualified base's intentional mode. A
  // future base profile needs its own explicitly reviewed runtime contract.
  apparmor: z.object({ profile: z.literal("zeros-cloud-engine"), mode: z.literal("unconfined") }).strict(),
  mounts: z.literal(true), storage: z.literal(true), credentials: z.literal(true), resources,
  custody: z.object({ common: scope, workload: scope,
    controller: z.object({ pid: positive.min(2).max(2147483647), startToken: ticks, scope }).strict() }).strict(),
  census: z.object({ sha256: hash, groups: positive.max(8192), processes: z.literal(1) }).strict(),
}).strict();
export const CloudBootProbeSchema = CloudBootInnerProbeSchema.extend({
  retirement: scope.extend({ populated: z.literal(0), pruned: z.literal(true) }).strict(), outputJoined: z.literal(true),
}).strict();
export const CloudBootCheckSchema = z.object({ schema: z.literal("zeros.cloud-boot-check/v1"), runtime: CloudBootWitnessSchema,
  attempt: CloudBootAttemptSchema, checkedAtMs: positive, probe: CloudBootProbeSchema }).strict();
export const CloudBuildAdmissionProofSchema = witness.extend({ version: z.literal(3), profile: z.literal("zeros-cloud-worker-v4"),
  qualifiedAtMs: positive, reportSha256: hash, containerInitStartTicks: ticks,
  namespaces: z.object({ cgroup: z.string().regex(/^cgroup:\[[0-9]{1,20}\]$/), mnt: z.string().regex(/^mnt:\[[0-9]{1,20}\]$/),
    pid: z.string().regex(/^pid:\[[0-9]{1,20}\]$/) }).strict(), qualificationId: uuid, evidenceSha256: hash, selectionSha256: hash,
  bootIntegritySha256: hash, kernelSha256: hash, bootCheckSha256: hash, checkedAtMs: positive, attempt: CloudBootAttemptSchema,
}).strict().refine(value => value.runtimeId === `r1-${value.manifestSha256}` && Buffer.byteLength(JSON.stringify(value)) <= 16384);

export function canonicalCloudBootValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalCloudBootValue).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalCloudBootValue(item)}`).join(",")}}`;
}
export const cloudBootDigest = (value: unknown) => createHash("sha256").update(canonicalCloudBootValue(value)).digest("hex");
export function parseCloudBootSelection(value: unknown) {
  const selected = CloudComputerQualificationSelectionSchema.parse(value);
  if (selected.mode === "build" && cloudBootDigest(selected.evidence) !== selected.evidenceSha256)
    throw new Error("Cloud build selection digest mismatch");
  return selected;
}
