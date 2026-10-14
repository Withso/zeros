import { constants } from "node:fs";
import { open, lstat, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { z } from "zod";
import { parseCloudReplicaDeviceCredential, type CloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { RunSchema, type RunStore } from "./receipts";
import { ERROR_CODES, ZerosDevError } from "./errors";
import { SetupObservationSchema } from "./setup-observation";
import { RuntimeObservationSchema } from "./runtime-observation";
import { AdmissionObservationSchema } from "./admission-observation";

export const ExecutionSchema = z.object({ workflowRunId: z.string().regex(/^[1-9][0-9]{0,19}$/), attempt: z.number().int().min(1).max(100),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
export type HourlyExecution = z.infer<typeof ExecutionSchema>;
const resultSchema = z.object({ success: z.boolean(), code: z.enum(ERROR_CODES).nullable(), runId: z.string().uuid(),
  setup: SetupObservationSchema.optional(), runtime: RuntimeObservationSchema.optional(), admission: AdmissionObservationSchema.optional() }).strict();
const payloadSchema = z.object({ schema: z.literal("zeros.dev-hourly/v1"), execution: ExecutionSchema, deviceId: z.string().uuid(),
  result: resultSchema,
  runs: z.array(RunSchema).max(3), completedAt: z.string().datetime() }).strict();
const envelopeSchema = z.object({ payload: payloadSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
const MAX_BYTES = 1024 * 1024;
const bad = () => new ZerosDevError("artifact_invalid");
const key = (value: CloudReplicaDeviceCredential) => {
  const credential = parseCloudReplicaDeviceCredential(value);
  return createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: credential.publicKey, d: credential.privateKey } });
};

const same = (a: { ino: number; dev: number }, b: { ino: number; dev: number }) => a.ino === b.ino && a.dev === b.dev;
async function readArtifact(file: string) {
  let input;
  try {
    input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.mode & 0o022 || before.size > MAX_BYTES) throw bad();
    const text = await input.readFile("utf8"), after = await input.stat(), named = await lstat(file);
    if (Buffer.byteLength(text) > MAX_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== named.ino || before.dev !== named.dev) throw bad();
    return { envelope: envelopeSchema.parse(JSON.parse(text)), info: before };
  } catch { throw bad(); }
  finally { await input?.close(); }
}

function authenticate(envelope: z.infer<typeof envelopeSchema>, credential: CloudReplicaDeviceCredential, expected: HourlyExecution): void {
  const { payload } = envelope;
  if (JSON.stringify(payload.execution) !== JSON.stringify(ExecutionSchema.parse(expected)) || payload.deviceId !== credential.deviceId ||
    !verify(null, Buffer.from(JSON.stringify(payload)), createPublicKey(key(credential)), Buffer.from(envelope.signature, "base64url")) ||
    new Set(payload.runs.map(run => run.runId)).size !== payload.runs.length) throw bad();
  if (payload.result.success && (!payload.runs.some(run => run.runId === payload.result.runId && run.hourly?.complete && run.deletionConfirmed) || payload.result.code !== null)) throw bad();
}

export async function importHourlyArtifact(file: string, store: RunStore, credential: CloudReplicaDeviceCredential, expected: HourlyExecution): Promise<void> {
  const { envelope } = await readArtifact(file), { payload } = envelope;
  authenticate(envelope, credential, expected);
  for (const run of payload.runs) {
    if (!run.hourly) throw bad();
    await store.withRun(run.runId, run.source, async handle => {
      // withRun/save rechecks fixture, device and all strict RunSchema fields.
      // Import into an empty store only; no artifact can rewrite local intent.
      if (handle.run.create || handle.run.hourly || handle.run.prompts.length) throw bad();
      handle.run = run; await handle.save();
    });
  }
}

export async function exportHourlyArtifact(file: string, store: RunStore, credential: CloudReplicaDeviceCredential,
  execution: HourlyExecution, result: z.infer<typeof resultSchema>, options: { replace?: boolean } = {}): Promise<void> {
  let output, parent, temporary: string | undefined;
  try {
    const runs = [];
    for (const id of await store.list()) {
      const run = await store.read(id);
      if (!run.hourly) throw bad();
      // Carry uncertain resources until exact product cleanup confirms them.
      // Completed predecessors no longer need to be copied every hour.
      if (id === result.runId || run.create && !run.deletionConfirmed || run.hourly.credentials.some(row => !row.revoked || !row.disconnected)) runs.push(run);
    }
    const payload = payloadSchema.parse({ schema: "zeros.dev-hourly/v1", execution, result, runs,
      deviceId: credential.deviceId, completedAt: new Date().toISOString() });
    const envelope = { payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), key(credential)).toString("base64url") };
    const bytes = JSON.stringify(envelope) + "\n";
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw bad();
    const directory = path.dirname(file);
    parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parentInfo = await parent.stat();
    if (!parentInfo.isDirectory() || parentInfo.uid !== process.getuid?.() || parentInfo.mode & 0o022 || await realpath(directory) !== directory) throw bad();
    const previous = options.replace ? await readArtifact(file) : undefined;
    if (previous) {
      authenticate(previous.envelope, credential, execution);
      if (previous.envelope.payload.result.runId !== result.runId || (previous.info.mode & 0o7777) !== 0o600) throw bad();
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
  } catch { throw bad(); }
  finally {
    await output?.close(); await parent?.close();
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
