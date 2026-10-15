import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { parseCloudReplicaDeviceCredential, type CloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { RunSchema, type Run, type RunStore } from "./receipts";
import type { Fixture } from "./config";
import type { ProductApi } from "./product";
import { CleanupHandoffReferenceSchema, RETIREMENT_FRESH_MS, type CleanupHandoffReference } from "./cleanup-contract";
import { CleanupRecoveryExecutionSchema, CleanupRecoveryReferenceSchema, type CleanupRecoveryReference } from "./cleanup-recovery-contract";
import { cleanupOutcome } from "./cleanup-state";
import { importCleanupHandoff } from "./cleanup-handoff";
import { readHourlyArtifactForRecovery, type HourlyExecution } from "./hourly-artifact";
import { ZerosDevError } from "./errors";

const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const payloadSchema = z.object({ schema: z.literal("zeros.dev-cleanup-recovery/v1"), scope: z.literal("cleanup-only"),
  deviceId: uuid, fixtureSha256: digest, createdAt: z.string().datetime(),
  sourceArtifactSha256: digest, sourceRunSha256: digest, sourceExecution: CleanupRecoveryExecutionSchema,
  runId: uuid, workspaceId: uuid, generation: z.number().int().positive().safe(), failedDeleteKey: uuid, approvalId: uuid,
  handoff: CleanupHandoffReferenceSchema.optional() }).strict();
const envelopeSchema = z.object({ payload: payloadSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
const MAX_BYTES = 16 * 1024, MAX_ENCODED_BYTES = 24 * 1024;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const invalid = () => new ZerosDevError("artifact_invalid");
const privateKey = (value: CloudReplicaDeviceCredential) => createPrivateKey({ format: "jwk",
  key: { kty: "OKP", crv: "Ed25519", x: value.publicKey, d: value.privateKey } });
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function boundRun(value: unknown): Run {
  const parsed = RunSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

function reference(payload: z.infer<typeof payloadSchema>, raw: string): CleanupRecoveryReference {
  return CleanupRecoveryReferenceSchema.parse({ version: 1, sha256: sha(raw), sourceArtifactSha256: payload.sourceArtifactSha256,
    sourceRunSha256: payload.sourceRunSha256, sourceExecution: payload.sourceExecution, runId: payload.runId,
    workspaceId: payload.workspaceId, generation: payload.generation, failedDeleteKey: payload.failedDeleteKey, approvalId: payload.approvalId });
}

function matchesFixture(run: Run, fixture: Fixture): boolean {
  const repository = run.create?.body.repository;
  return run.create?.result?.createdBy === fixture.accountId && repository?.forge === "github.com" &&
    repository.owner.toLowerCase() === fixture.repository.owner.toLowerCase() && repository.name.toLowerCase() === fixture.repository.name.toLowerCase() &&
    repository.githubInstallationId === fixture.repository.installationId;
}

function decode(encoded: string, fixture: Fixture, device: CloudReplicaDeviceCredential) {
  try {
    const credential = parseCloudReplicaDeviceCredential(device);
    if (!encoded || encoded.length > MAX_ENCODED_BYTES || Buffer.from(encoded, "base64").toString("base64") !== encoded ||
      credential.accountUserId !== fixture.accountId || !credential.deviceId) throw invalid();
    const raw = Buffer.from(encoded, "base64").toString("utf8");
    if (Buffer.byteLength(raw) > MAX_BYTES) throw invalid();
    const envelope = envelopeSchema.parse(JSON.parse(raw)), { payload } = envelope;
    if (raw !== JSON.stringify(envelope) || payload.deviceId !== credential.deviceId || payload.fixtureSha256 !== sha(JSON.stringify(fixture)) ||
      Date.parse(payload.createdAt) > Date.now() + 60_000 ||
      !verify(null, Buffer.from(JSON.stringify(payload)), createPublicKey(privateKey(credential)), Buffer.from(envelope.signature, "base64url"))) throw invalid();
    return { payload, reference: reference(payload, raw) };
  } catch { throw invalid(); }
}

/** Read-only producer. Signing selects an approved operator request; the
 * exporter verifies current CP retirement but transports no cached proof.
 * Each Actions admission must obtain its own fresh authenticated observation. */
export type CleanupRecoveryRequest = { artifact: string; runId: string; approvalId: string; execution: HourlyExecution; file: string };
export async function exportCleanupRecovery(options: CleanupRecoveryRequest & {
  credentialFile?: string; fixture: Fixture; credential: CloudReplicaDeviceCredential;
  api: Pick<ProductApi, "readRetirement">; signal: AbortSignal }) {
  const credential = parseCloudReplicaDeviceCredential(options.credential);
  if (!uuid.safeParse(options.runId).success || !uuid.safeParse(options.approvalId).success || credential.accountUserId !== options.fixture.accountId ||
    !credential.deviceId) throw new ZerosDevError("invalid_request");
  if (options.signal.aborted) throw new ZerosDevError("deadline");
  const source = await readHourlyArtifactForRecovery(options.artifact, credential, options.execution, options.credentialFile), { payload } = source;
  const run = payload.runs.find(row => row.runId === options.runId), last = run?.lifecycle.at(-1);
  if (payload.schema === "zeros.dev-hourly/v1" || payload.cleanupRecovery || payload.result.success || payload.result.runId !== options.runId ||
    !run?.hourly || run.cleanupOnly || run.cleanupRecovery || run.deletionConfirmed || run.retirement || !run.create?.result ||
    run.fixtureSha256 !== sha(JSON.stringify(options.fixture)) || !matchesFixture(run, options.fixture) ||
    last?.operation !== "delete" || last.confirmed || last.settled) throw invalid();
  const recovery = payloadSchema.parse({ schema: "zeros.dev-cleanup-recovery/v1", scope: "cleanup-only", deviceId: credential.deviceId,
    fixtureSha256: run.fixtureSha256, createdAt: new Date().toISOString(), sourceArtifactSha256: source.sha256,
    sourceRunSha256: sha(JSON.stringify(run)), sourceExecution: payload.execution, runId: run.runId,
    workspaceId: run.create.result.id, generation: run.create.result.generation, failedDeleteKey: last.key, approvalId: options.approvalId,
    ...(payload.handoff ? { handoff: payload.handoff } : {}) });
  const raw = JSON.stringify({ payload: recovery, signature: sign(null, Buffer.from(JSON.stringify(recovery)), privateKey(credential)).toString("base64url") });
  const encoded = Buffer.from(raw).toString("base64"), decoded = decode(encoded, options.fixture, credential);
  const candidate = boundRun({ ...run, cleanupRecovery: decoded.reference });
  const proof = await options.api.readRetirement(candidate, options.signal);
  if (options.signal.aborted) throw new ZerosDevError("deadline");
  if (cleanupOutcome({ ...candidate, retirement: proof, deletionConfirmed: proof.deletionConfirmed }) === "unconfirmed" ||
      proof.organizationId !== options.fixture.organizationId || Math.abs(Date.now() - Date.parse(proof.observedAt)) > RETIREMENT_FRESH_MS) throw invalid();
  const file = path.resolve(options.file), directory = path.dirname(file);
  let parent, output;
  try {
    parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parentInfo = await parent.stat();
    if (!parentInfo.isDirectory() || parentInfo.uid !== process.getuid?.() || parentInfo.mode & 0o022 || await realpath(directory) !== directory) throw invalid();
    output = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const info = await output.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600) throw invalid();
    await output.writeFile(encoded); await output.sync();
    const named = await lstat(file), namedParent = await lstat(directory);
    if (named.ino !== info.ino || named.dev !== info.dev || namedParent.ino !== parentInfo.ino || namedParent.dev !== parentInfo.dev) throw invalid();
    await parent.sync();
  } catch { throw invalid(); }
  finally { await output?.close(); await parent?.close(); }
  return { state: "ready" as const, sha256: decoded.reference.sha256, runCount: 1 };
}

/** An append to the restored predecessor, never a replacement run or a product
 * request. No cached retirement is installed. prior_cleanup must read CP before
 * allocation. The consumed reference survives physical deletion and replay. */
export async function importCleanupRecovery(encoded: string, store: RunStore, credential: CloudReplicaDeviceCredential,
  options: { sourceArtifactSha256?: string; handoff?: CleanupHandoffReference; consumed?: CleanupRecoveryReference } = {}) {
  const { payload, reference } = decode(encoded, store.fixture, credential);
  if (!equal(payload.handoff, options.handoff)) throw invalid();
  if (options.consumed) {
    const parsed = CleanupRecoveryReferenceSchema.safeParse(options.consumed);
    if (!parsed.success || !equal(parsed.data, reference)) throw invalid();
    return reference;
  }
  if (options.sourceArtifactSha256 !== reference.sourceArtifactSha256) throw invalid();
  await store.withRun(reference.runId, null, async handle => {
    const run = handle.run;
    if (run.cleanupRecovery) {
      if (!equal(run.cleanupRecovery, reference)) throw invalid();
      return;
    }
    if (run.cleanupOnly || run.deletionConfirmed || run.retirement || !matchesFixture(run, store.fixture) ||
      sha(JSON.stringify(run)) !== reference.sourceRunSha256) throw invalid();
    handle.run = boundRun({ ...run, cleanupRecovery: reference });
    await handle.save();
  });
  return reference;
}

/** Both closed formats use the already masked cleanup secret. Keep the old
 * local-run handoff and the operator recovery consumption separate. */
export async function importCleanupInput(encoded: string, store: RunStore, credential: CloudReplicaDeviceCredential,
  options: { sourceArtifactSha256?: string; handoff?: CleanupHandoffReference; cleanupRecovery?: CleanupRecoveryReference } = {}) {
  let recovery = false;
  try {
    if (encoded.length > 48 * 1024) throw invalid();
    recovery = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))?.payload?.schema === "zeros.dev-cleanup-recovery/v1";
  } catch { throw invalid(); }
  if (recovery) return { handoff: options.handoff, cleanupRecovery: await importCleanupRecovery(encoded, store, credential,
    { sourceArtifactSha256: options.sourceArtifactSha256, handoff: options.handoff, consumed: options.cleanupRecovery }) };
  return { handoff: await importCleanupHandoff(encoded, store, credential, options.handoff), cleanupRecovery: options.cleanupRecovery };
}
