import { z } from "zod";

// Mirrored in the standalone control plane. These are behavioral build
// evidence, never bearer authority or a substitute for a fresh boot witness.
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const revision = z.number().int().positive().safe();
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const text = z.string().regex(/^[\x20-\x7e]{1,256}$/);
const utf8 = new TextEncoder();
export const COMPUTER_BUILD_QUALIFICATION_MAX_BYTES = 64 * 1024;

export const CloudComputerBuildQualificationSchema = z.object({
  schema: z.literal("zeros.computer-build-qualification/v1"),
  scope: z.object({
    organizationId: uuid, buildId: uuid, configId: uuid, provider: z.literal("boat"),
    channel: z.enum(["development", "alpha", "beta", "production"]), accountScope: name,
    billingOrg: z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/),
  }).strict(),
  builder: z.object({
    operationKey: z.string().max(255), sandboxId: z.string().regex(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/),
    helperFence: revision, workerFence: revision, bootId: uuid,
  }).strict(),
  runtime: z.object({
    runtimeId: z.string().regex(/^r1-[a-f0-9]{64}$/), manifestSha256: hash, archiveSha256: hash,
    engineProtocolVersion: z.number().int().min(1).max(65535), installerReceiptSha256: hash,
  }).strict(),
  base: z.object({
    baseImageId: name, baseCompatibilityId: z.string().regex(/^bc1-[a-f0-9]{64}$/), compatibilitySha256: hash,
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), architecture: z.literal("linux/amd64"),
    protectedContractSha256: hash, bootIntegritySha256: hash,
  }).strict(),
  kernel: z.object({
    release: text, version: text, architecture: z.literal("x86_64"),
    buildId: z.string().regex(/^(?:[a-f0-9]{2}){1,128}$/), notesSha256: hash,
    features: z.object({ cgroupV2: z.literal(true), userNamespaces: z.literal(true),
      seccompFilter: z.literal(true), apparmor: z.literal(true) }).strict(),
  }).strict(),
  policy: z.object({ version: z.literal(1), sha256: hash, resourcePolicySha256: hash,
    runnerVersion: z.literal(1).optional() }).strict(),
  results: z.object({
    runtime: z.literal(true), identity: z.literal(true), resources: z.literal(true), mounts: z.literal(true),
    credentials: z.literal(true), actorTools: z.literal(true), lsps: z.literal(true), capture: z.literal(true),
    humanServices: z.literal(true), setupProcess: z.literal(true), retirement: z.literal(true), census: z.literal(true),
    runner: z.literal(true).optional(),
  }).strict(),
  reportSha256: hash, sanitationManifestSha256: hash, qualifiedAt: z.string().datetime({ offset: true }),
}).strict().refine(value =>
  value.runtime.runtimeId === `r1-${value.runtime.manifestSha256}` &&
  value.base.baseCompatibilityId === `bc1-${value.base.compatibilitySha256}` &&
  value.builder.operationKey === `computer-build:${value.scope.buildId}` &&
  value.builder.helperFence <= value.builder.workerFence &&
  (value.policy.runnerVersion === 1) === (value.results.runner === true) &&
  utf8.encode(JSON.stringify(value)).length <= COMPUTER_BUILD_QUALIFICATION_MAX_BYTES,
"Build qualification identity or complete result set is inconsistent");
export type CloudComputerBuildQualification = z.infer<typeof CloudComputerBuildQualificationSchema>;

export const CloudComputerBuildSelectionSchema = z.object({
  mode: z.literal("build"), qualificationId: uuid, evidenceSha256: hash,
  evidence: CloudComputerBuildQualificationSchema,
  snapshot: z.object({
    name: z.string().max(63).regex(/^[a-z0-9][a-z0-9-]*-(development|alpha|beta|production)-computer-v[1-9][0-9]{0,18}$/),
    snapshotId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/), treeSha256: hash,
  }).strict(),
}).strict().refine(value => value.snapshot.name.includes(`-${value.evidence.scope.channel}-computer-v`) &&
  utf8.encode(JSON.stringify(value)).length <= COMPUTER_BUILD_QUALIFICATION_MAX_BYTES);
export type CloudComputerBuildSelection = z.infer<typeof CloudComputerBuildSelectionSchema>;

/** Absence is legacy negotiation. Once present, a build selection must remain
 * complete; parser failure cannot turn it into a full-qualification attempt. */
export const CloudComputerQualificationSelectionSchema = z.union([
  z.object({ mode: z.literal("full") }).strict(), CloudComputerBuildSelectionSchema,
]);
export type CloudComputerQualificationSelection = z.infer<typeof CloudComputerQualificationSelectionSchema>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

/** Canonical UTF-8 JSON is hashed and stored intact, not jsonb's re-encoding. */
export function canonicalBuildQualification(value: unknown): string {
  return canonical(CloudComputerBuildQualificationSchema.parse(value));
}
