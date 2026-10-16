import { constants } from "node:fs";
import { open, lstat, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { z } from "zod";
import { parseCloudReplicaDeviceCredential, type CloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { RunSchema, type RunStore } from "./receipts";
import { ERROR_CODES, ZerosDevError } from "./errors";
import { SetupObservationSchema } from "./setup-observation";
import { RuntimeObservationSchema } from "./runtime-observation";
import { AdmissionObservationSchema } from "./admission-observation";
import { TransportObservationSchema } from "./gate0-contract";
import { NativeProofObservationSchema } from "./native-proof-observation";
import { CleanupHandoffReferenceSchema, CleanupSummarySchema, MAX_CARRIED_RUNS, type CleanupHandoffReference, type CleanupSummary } from "./cleanup-contract";
import { cleanupOutcome, requireCleanupCapacity, requireComputeCleanup, summarizeCleanup } from "./cleanup-state";
import { InfrastructureCoverageSchema, OWNER_SECTION7_COVERAGE } from "./infrastructure-contract";
import { PRESTART_RECOVERY } from "./prestart-recovery.mjs";
import { CleanupRecoveryReferenceSchema, type CleanupRecoveryReference } from "./cleanup-recovery-contract";

export const ExecutionSchema = z.object({ workflowRunId: z.string().regex(/^[1-9][0-9]{0,19}$/), attempt: z.number().int().min(1).max(100),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
export type HourlyExecution = z.infer<typeof ExecutionSchema>;
export const PrestartRecoverySchema = z.object({ version: z.literal(1), workflowRunId: z.literal(PRESTART_RECOVERY.workflowRunId),
  attempt: z.literal(1), sourceSha: z.literal(PRESTART_RECOVERY.sourceSha), jobId: z.literal(PRESTART_RECOVERY.jobId),
  cause: z.literal(PRESTART_RECOVERY.cause) }).strict();
export type PrestartRecovery = z.infer<typeof PrestartRecoverySchema>;
const resultSchema = z.object({ success: z.boolean(), code: z.enum(ERROR_CODES).nullable(), runId: z.string().uuid(),
  setup: SetupObservationSchema.optional(), runtime: RuntimeObservationSchema.optional(), admission: AdmissionObservationSchema.optional(),
  transport: TransportObservationSchema.optional(), nativeProof: NativeProofObservationSchema.optional() }).strict()
  .refine(result => !result.nativeProof || !result.success && result.code === "detached_proof_incomplete",
    "Native diagnostic requires a failed native proof result");
const legacyPayloadSchema = z.object({ schema: z.literal("zeros.dev-hourly/v1"), execution: ExecutionSchema, deviceId: z.string().uuid(),
  result: resultSchema,
  runs: z.array(RunSchema).max(3), completedAt: z.string().datetime() }).strict();
const currentPayloadSchema = legacyPayloadSchema.extend({ schema: z.literal("zeros.dev-hourly/v2"),
  runs: z.array(RunSchema).max(MAX_CARRIED_RUNS), cleanup: CleanupSummarySchema, handoff: CleanupHandoffReferenceSchema.optional(),
  prestartRecovery: PrestartRecoverySchema.optional(), cleanupRecovery: CleanupRecoveryReferenceSchema.optional() }).strict();
const infrastructurePayloadSchema = currentPayloadSchema.extend({ schema: z.literal("zeros.dev-infrastructure/v1"),
  coverage: InfrastructureCoverageSchema }).strict();
const payloadSchema = z.discriminatedUnion("schema", [legacyPayloadSchema, currentPayloadSchema, infrastructurePayloadSchema]);
const envelopeSchema = z.object({ payload: payloadSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
const MAX_BYTES = 1024 * 1024;
export const PublicHourlyTrustSchema = z.object({ deviceId: z.string().uuid(), publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export type PublicHourlyTrust = z.infer<typeof PublicHourlyTrustSchema>;
const bad = () => new ZerosDevError("artifact_invalid");
const key = (value: CloudReplicaDeviceCredential) => {
  const credential = parseCloudReplicaDeviceCredential(value);
  return createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: credential.publicKey, d: credential.privateKey } });
};

const same = (a: { ino: number; dev: number }, b: { ino: number; dev: number }) => a.ino === b.ino && a.dev === b.dev;
async function readArtifact(file: string, forbiddenFile?: string) {
  let input;
  try {
    if (forbiddenFile && path.resolve(file) === path.resolve(forbiddenFile)) throw bad();
    input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.mode & 0o022 || before.size > MAX_BYTES) throw bad();
    if (forbiddenFile && (same(before, await lstat(forbiddenFile)) || await realpath(file) === await realpath(forbiddenFile))) throw bad();
    const text = await input.readFile("utf8"), after = await input.stat(), named = await lstat(file);
    if (Buffer.byteLength(text) > MAX_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== named.ino || before.dev !== named.dev) throw bad();
    return { envelope: envelopeSchema.parse(JSON.parse(text)), info: before, sha256: createHash("sha256").update(text).digest("hex") };
  } catch { throw bad(); }
  finally { await input?.close(); }
}

function authenticate(envelope: z.infer<typeof envelopeSchema>, credential: CloudReplicaDeviceCredential, expected: HourlyExecution): void {
  verifyPublicHourlyArtifact(envelope, { deviceId: credential.deviceId!, publicKey: credential.publicKey }, expected);
}

/** Read-only reports need the pinned public verifier, never a fixture password,
 * private device key, provider credential or access to the product account. */
export function verifyPublicHourlyArtifact(raw: unknown, trust: PublicHourlyTrust, expected: HourlyExecution) {
  try {
    const { deviceId, publicKey } = PublicHourlyTrustSchema.parse(trust), envelope = envelopeSchema.parse(raw), { payload } = envelope;
    const publicBytes = Buffer.from(publicKey, "base64url");
    if (publicBytes.length !== 32 || publicBytes.toString("base64url") !== publicKey || Buffer.byteLength(JSON.stringify(envelope)) > MAX_BYTES ||
      JSON.stringify(payload.execution) !== JSON.stringify(ExecutionSchema.parse(expected)) || payload.deviceId !== deviceId ||
      !verify(null, Buffer.from(JSON.stringify(payload)), createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: publicKey } }),
        Buffer.from(envelope.signature, "base64url")) || new Set(payload.runs.map(run => run.runId)).size !== payload.runs.length ||
      payload.runs.some(run => run.deviceId !== deviceId)) throw bad();
    const primary = payload.runs.find(run => run.runId === payload.result.runId);
    if (primary && (!primary.hourly || primary.hourly.workflowRunId !== expected.workflowRunId || primary.hourly.attempt !== expected.attempt ||
      primary.hourly.sourceSha !== expected.sourceSha || primary.source.dirty || primary.source.revision !== expected.sourceSha)) throw bad();
    if (payload.result.success !== (payload.result.code === null) || primary?.cleanupOnly || primary?.cleanupRecovery ||
      new Set(payload.runs.map(run => run.fixtureSha256)).size > 1) throw bad();
    const infrastructure = payload.schema === "zeros.dev-infrastructure/v1";
    if (primary && infrastructure !== Boolean(primary.hourly?.infrastructure) || infrastructure && primary &&
      (primary.prompts.length > 0 || primary.hourly?.complete || primary.hourly?.rehearsal)) throw bad();
    if (payload.schema === "zeros.dev-hourly/v1") {
      if (payload.runs.some(run => run.retirement || run.cleanupOnly || run.cleanupRecovery) ||
        payload.result.success && (!primary?.hourly?.complete || !primary.deletionConfirmed)) throw bad();
    } else {
      if (JSON.stringify(payload.cleanup) !== JSON.stringify(summarizeCleanup(payload.runs, primary)) ||
        payload.runs.some(run => run.cleanupOnly && (run.hourly || run.cleanupOnly.handoffSha256 !== payload.handoff?.sha256 ||
          !payload.handoff.runIds.includes(run.runId)))) throw bad();
      if (payload.runs.some(run => run.cleanupRecovery && JSON.stringify(run.cleanupRecovery) !== JSON.stringify(payload.cleanupRecovery))) throw bad();
      if (payload.result.success) {
        const completed = infrastructure ? primary?.hourly?.infrastructure?.complete : primary?.hourly?.complete;
        if (!primary || !completed || infrastructure && !primary.create?.result ||
          payload.runs.some(run => run.hourly?.credentials.some(row => !row.revoked || !row.disconnected))) throw bad();
        requireComputeCleanup(primary); requireCleanupCapacity(payload.runs);
      }
    }
    return payload;
  } catch { throw bad(); }
}

/** Recovery producers verify the exact failed artifact before selecting a run.
 * The file digest binds bytes, including the existing envelope signature. */
export async function readHourlyArtifactForRecovery(file: string, credential: CloudReplicaDeviceCredential,
  expected: HourlyExecution, forbiddenFile?: string) {
  const { envelope, info, sha256 } = await readArtifact(file, forbiddenFile);
  if ((info.mode & 0o7777) !== 0o600) throw bad();
  authenticate(envelope, credential, expected);
  return { payload: envelope.payload, sha256 };
}

export async function importHourlyArtifact(file: string, store: RunStore, credential: CloudReplicaDeviceCredential, expected: HourlyExecution,
  options: { includeSourceDigest?: boolean } = {}): Promise<{ handoff?: CleanupHandoffReference; prestartRecovery?: PrestartRecovery;
    cleanupRecovery?: CleanupRecoveryReference; sourceArtifactSha256?: string }> {
  const { envelope, sha256 } = await readArtifact(file), { payload } = envelope;
  authenticate(envelope, credential, expected);
  for (const run of payload.runs) {
    if (!run.hourly && !run.cleanupOnly) throw bad();
    await store.withRun(run.runId, run.source, async handle => {
      // withRun/save rechecks fixture, device and all strict RunSchema fields.
      // Import into an empty store only; no artifact can rewrite local intent.
      if (handle.run.create || handle.run.hourly || handle.run.cleanupOnly || handle.run.prompts.length) throw bad();
      handle.run = run; await handle.save();
    });
  }
  return {
    ...(payload.schema === "zeros.dev-hourly/v1" ? {} : {
      ...(payload.handoff ? { handoff: payload.handoff } : {}), ...(payload.prestartRecovery ? { prestartRecovery: payload.prestartRecovery } : {}),
      ...(payload.cleanupRecovery ? { cleanupRecovery: payload.cleanupRecovery } : {}) }),
    ...(options.includeSourceDigest ? { sourceArtifactSha256: sha256 } : {}),
  };
}

export async function exportHourlyArtifact(file: string, store: RunStore, credential: CloudReplicaDeviceCredential,
  execution: HourlyExecution, result: z.infer<typeof resultSchema>, options: { replace?: boolean; handoff?: CleanupHandoffReference;
    profile?: "hourly" | "gate0" | "infrastructure"; prestartRecovery?: PrestartRecovery;
    cleanupRecovery?: CleanupRecoveryReference } = {}): Promise<CleanupSummary> {
  let output, parent, temporary: string | undefined;
  try {
    const runs = [];
    for (const id of await store.list()) {
      const run = await store.read(id);
      if (!run.hourly && !run.cleanupOnly || run.cleanupOnly && (run.hourly || run.cleanupOnly.handoffSha256 !== options.handoff?.sha256 ||
        !options.handoff.runIds.includes(run.runId))) throw bad();
      if (run.cleanupRecovery && JSON.stringify(run.cleanupRecovery) !== JSON.stringify(options.cleanupRecovery)) throw bad();
      // Carry uncertain resources until exact product cleanup confirms them.
      // Completed predecessors no longer need to be copied every hour.
      if (id === result.runId || run.create && cleanupOutcome(run) !== "physically_deleted" || run.hourly?.credentials.some(row => !row.revoked || !row.disconnected)) runs.push(run);
    }
    const infrastructure = options.profile === "infrastructure";
    const payload = (infrastructure ? infrastructurePayloadSchema : currentPayloadSchema).parse({
      schema: infrastructure ? "zeros.dev-infrastructure/v1" : "zeros.dev-hourly/v2", execution, result, runs,
      ...(infrastructure ? { coverage: OWNER_SECTION7_COVERAGE } : {}),
      deviceId: credential.deviceId, completedAt: new Date().toISOString(),
      cleanup: summarizeCleanup(runs, runs.find(run => run.runId === result.runId)), ...(options.handoff ? { handoff: options.handoff } : {}),
      ...(options.prestartRecovery ? { prestartRecovery: options.prestartRecovery } : {}),
      ...(options.cleanupRecovery ? { cleanupRecovery: options.cleanupRecovery } : {}) });
    const envelope = { payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), key(credential)).toString("base64url") };
    authenticate(envelope, credential, execution);
    const bytes = JSON.stringify(envelope) + "\n";
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw bad();
    const directory = path.dirname(file);
    parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parentInfo = await parent.stat();
    if (!parentInfo.isDirectory() || parentInfo.uid !== process.getuid?.() || parentInfo.mode & 0o022 || await realpath(directory) !== directory) throw bad();
    const previous = options.replace ? await readArtifact(file) : undefined;
    if (previous) {
      authenticate(previous.envelope, credential, execution);
      if (previous.envelope.payload.result.runId !== result.runId || previous.envelope.payload.schema !== payload.schema ||
        JSON.stringify(previous.envelope.payload.prestartRecovery) !== JSON.stringify(payload.prestartRecovery) ||
        (previous.info.mode & 0o7777) !== 0o600) throw bad();
      if (previous.envelope.payload.cleanupRecovery &&
        JSON.stringify(previous.envelope.payload.cleanupRecovery) !== JSON.stringify(payload.cleanupRecovery)) throw bad();
      temporary = path.join(directory, `.receipt-${randomUUID()}`);
    }
    output = await open(temporary ?? file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const info = await output.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600) throw bad();
    await output.writeFile(bytes); await output.sync();
    if (previous && temporary) {
      if (!same(previous.info, await lstat(file)) || !same(parentInfo, await lstat(directory))) throw bad();
      await rename(temporary, file); temporary = undefined;
    }
    await parent.sync();
    return payload.cleanup;
  } catch { throw bad(); }
  finally {
    await output?.close(); await parent?.close();
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
