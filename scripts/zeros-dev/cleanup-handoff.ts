import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { parseCloudReplicaDeviceCredential, type CloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { RunSchema, type Run, type RunStore } from "./receipts";
import type { ProductApi } from "./product";
import type { Fixture } from "./config";
import { CleanupHandoffReferenceSchema, type CleanupHandoffReference } from "./cleanup-contract";
import { requireCleanupCapacity, retirementMatchesRun } from "./cleanup-state";
import { ZerosDevError } from "./errors";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const payloadSchema = z.object({ schema: z.literal("zeros.dev-cleanup-handoff/v1"), scope: z.literal("cleanup-only"),
  deviceId: z.string().uuid(), fixtureSha256: digest, createdAt: z.string().datetime(),
  runs: z.array(z.object({ sourceRunSha256: digest, run: RunSchema }).strict()).min(1).max(4),
}).strict();
const envelopeSchema = z.object({ payload: payloadSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
const MAX_BYTES = 32 * 1024, MAX_ENCODED_BYTES = 48 * 1024;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const invalid = () => new ZerosDevError("artifact_invalid");
const privateKey = (credential: CloudReplicaDeviceCredential) => createPrivateKey({ format: "jwk",
  key: { kty: "OKP", crv: "Ed25519", x: credential.publicKey, d: credential.privateKey } });

function matchesFixture(run: Run, fixture: Fixture): boolean {
  const repository = run.create?.body.repository;
  return run.create?.result?.createdBy === fixture.accountId && repository?.forge === "github.com" &&
    repository.owner.toLowerCase() === fixture.repository.owner.toLowerCase() &&
    repository.name.toLowerCase() === fixture.repository.name.toLowerCase() &&
    repository.githubInstallationId === fixture.repository.installationId;
}

function cleanupProjection(run: Run, retirement: NonNullable<Run["retirement"]>): Run {
  if (run.hourly || run.cleanupOnly || !run.create?.result || !retirementMatchesRun(run, retirement)) throw invalid();
  return RunSchema.parse({ version: 1, runId: run.runId, fixtureSha256: run.fixtureSha256, deviceId: run.deviceId,
    createdAt: run.createdAt, source: run.source, create: run.create, lifecycle: run.lifecycle,
    prompts: [], evidence: [], retirement, deletionConfirmed: retirement.deletionConfirmed });
}

function decode(encoded: string, fixture: Fixture, credentialInput: CloudReplicaDeviceCredential) {
  try {
    const credential = parseCloudReplicaDeviceCredential(credentialInput);
    if (credential.accountUserId !== fixture.accountId || !credential.deviceId || !encoded || encoded.length > MAX_ENCODED_BYTES ||
      Buffer.from(encoded, "base64").toString("base64") !== encoded) throw invalid();
    const raw = Buffer.from(encoded, "base64").toString("utf8");
    if (Buffer.byteLength(raw) > MAX_BYTES) throw invalid();
    const envelope = envelopeSchema.parse(JSON.parse(raw)), { payload } = envelope;
    if (raw !== JSON.stringify(envelope) || payload.deviceId !== credential.deviceId || payload.fixtureSha256 !== sha(JSON.stringify(fixture)) ||
      new Set(payload.runs.map(row => row.run.runId)).size !== payload.runs.length ||
      new Set(payload.runs.map(row => row.run.create?.result?.id)).size !== payload.runs.length ||
      Date.parse(payload.createdAt) > Date.now() + 60_000 ||
      !verify(null, Buffer.from(JSON.stringify(payload)), createPublicKey(privateKey(credential)), Buffer.from(envelope.signature, "base64url"))) throw invalid();
    for (const { run } of payload.runs) {
      if (run.deviceId !== payload.deviceId || run.fixtureSha256 !== payload.fixtureSha256 || !run.retirement ||
        !matchesFixture(run, fixture) || run.retirement.organizationId !== fixture.organizationId ||
        JSON.stringify(cleanupProjection(run, run.retirement)) !== JSON.stringify(run)) throw invalid();
    }
    requireCleanupCapacity(payload.runs.map(row => row.run));
    return { payload, reference: CleanupHandoffReferenceSchema.parse({ sha256: sha(raw), runIds: payload.runs.map(row => row.run.runId) }) };
  } catch { throw invalid(); }
}

/** Explicit owner handoff, never discovery. Product calls are read-only; the
 * local source envelopes are authenticated by RunStore before projection. */
export async function exportCleanupHandoff(options: { file: string; runIds: string[]; store: RunStore;
  credential: CloudReplicaDeviceCredential; api: Pick<ProductApi, "readRetirement">; signal: AbortSignal }) {
  const ids = z.array(z.string().uuid()).min(1).max(4).safeParse(options.runIds);
  if (!ids.success || new Set(ids.data).size !== ids.data.length) throw new ZerosDevError("invalid_request");
  const credential = parseCloudReplicaDeviceCredential(options.credential), runs = [];
  for (const id of [...ids.data].sort()) {
    if (options.signal.aborted) throw new ZerosDevError("deadline");
    const run = await options.store.read(id);
    if (run.hourly || run.cleanupOnly || !run.create?.result || !matchesFixture(run, options.store.fixture)) throw invalid();
    const retirement = await options.api.readRetirement(run, options.signal);
    runs.push({ sourceRunSha256: sha(JSON.stringify(run)), run: cleanupProjection(run, retirement) });
  }
  const payload = payloadSchema.parse({ schema: "zeros.dev-cleanup-handoff/v1", scope: "cleanup-only", deviceId: credential.deviceId,
    fixtureSha256: sha(JSON.stringify(options.store.fixture)), createdAt: new Date().toISOString(), runs });
  const raw = JSON.stringify({ payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey(credential)).toString("base64url") });
  const encoded = Buffer.from(raw).toString("base64"), { reference } = decode(encoded, options.store.fixture, credential);
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
  return { state: "ready" as const, sha256: reference.sha256, runCount: reference.runIds.length };
}

/** A consumed manifest remains in the signed artifact even after its resources
 * are physically gone. Replaying the variable cannot resurrect cleanup work. */
export async function importCleanupHandoff(encoded: string, store: RunStore, credential: CloudReplicaDeviceCredential,
  consumed?: CleanupHandoffReference): Promise<CleanupHandoffReference> {
  const { payload, reference } = decode(encoded, store.fixture, credential);
  if (consumed) {
    if (JSON.stringify(CleanupHandoffReferenceSchema.parse(consumed)) !== JSON.stringify(reference)) throw invalid();
    return reference;
  }
  // Validate collisions before materializing anything; never overwrite an
  // Actions intent or another owner's local receipt with an operator handoff.
  const present = new Set(await store.list());
  for (const { run } of payload.runs) if (present.has(run.runId)) throw invalid();
  for (const { run, sourceRunSha256 } of payload.runs) await store.withRun(run.runId, run.source, async handle => {
    if (handle.run.create || handle.run.hourly || handle.run.cleanupOnly || handle.run.prompts.length) throw invalid();
    handle.run = { ...run, cleanupOnly: { handoffSha256: reference.sha256, sourceRunSha256 } }; await handle.save();
  });
  return reference;
}
