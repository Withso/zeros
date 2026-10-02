import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import type { ReleaseCanaryRequest } from "./release-canaries.js";
import { ReleaseCanaryBindingsSchema, type ReleaseCanaryRetirement, type ReleaseCanaryRetirementAudit } from "./release-canary-contract.js";
import { releaseCanaryRetirementJournal } from "./release-canary-retirement.js";

const channels = ["alpha", "beta", "production"] as const;
export const releaseWorkerOwner = (channel: string) => createHash("sha256").update(`zeros-release-worker:${channel}`).digest("hex").slice(0, 24);
export const releaseSnapshotChannel = (name: string) => channels.find(channel => name.startsWith(`dev-${releaseWorkerOwner(channel)}-`) || name.startsWith(`zeros-${channel}-`));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Profile = { boat: { accountScope: string; billingOrg: string; baseSnapshot: string }; railway: { projectId: string };
  planetscale: { organization: string; database: string }; cloudflare: { accountId: string }; admission?: { maxNamedSnapshots?: number; snapshotHeadroom?: number; maxBuilders?: number } };
type Reservation = { kind: "generation" | "builder"; owner: string; generation: string; computeId?: string; snapshotName?: string;
  capacityClass?: "custom"; createdAt: string; releasedAt?: string; snapshotReleasedAt?: string };
type Ledger = { version: 1; owner: "account-admission"; account: string; reservations: Reservation[]; policy?: unknown };
type Document = { state: any; etag: string };
export type BoatAccountStore = { readAdmission(): Promise<Document | null>; writeAdmission(ledger: Ledger, etag: string): Promise<unknown>;
  readDocument(key: string, owner: string): Promise<Document | null> };
type Image = { id: string; org_id: string; account_scope: string; snapshot_name: string; created_at: Date };
const accountIdentity = (profile: Profile) => digest(JSON.stringify([profile.boat.accountScope, profile.boat.billingOrg, profile.railway.projectId,
  profile.planetscale.organization, profile.planetscale.database, profile.cloudflare.accountId]));
function unavailable(message = "image capacity reached; shared Boat admission must be reconciled"): never { throw new Error(message); }

export function protectedBoatSnapshotCapacity(profile: Profile, inventory: string[], reservations: Reservation[], candidate?: string, lane: "release" | "non-release" = "release") {
  const names = new Set(inventory);
  if (!names.has(profile.boat.baseSnapshot)) unavailable();
  for (const row of reservations) if (row.kind === "builder" && row.snapshotName && !row.snapshotReleasedAt) names.add(row.snapshotName);
  if (candidate) names.add(candidate);
  if ([...names].some(name => !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) || lane === "non-release" && candidate && releaseSnapshotChannel(candidate)) unavailable();
  return { used: names.size };
}

export function sealBoatAccountDocument(state: { owner: string }, key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) unavailable();
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(`zeros-dev:v1:${state.owner}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
  const body = JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
  if (Buffer.byteLength(body) > 1024 * 1024) unavailable();
  return body;
}
export function openBoatAccountDocument(body: string, key: string, owner: string) {
  try {
    if (!/^[a-f0-9]{64}$/.test(key) || Buffer.byteLength(body) > 1024 * 1024) unavailable();
    const sealed = JSON.parse(body);
    if (sealed.version !== 1) unavailable();
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(Buffer.from(`zeros-dev:v1:${owner}`)); decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const document = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString());
    if (document.owner !== owner) unavailable(); return document;
  } catch { return unavailable(); }
}
const name = z.string().min(1).max(256);
const configuration = z.object({ version: z.literal(1), registry: z.object({ endpoint: z.string().url().refine(value => new URL(value).protocol === "https:" && new URL(value).hostname.endsWith(".r2.cloudflarestorage.com")),
  bucket: name, accessKeyId: name, secretAccessKey: name, encryptionKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), profile: z.object({
  boat: z.object({ accountScope: name, billingOrg: name, baseSnapshot: name }).strict(), railway: z.object({ projectId: name }).strict(),
  planetscale: z.object({ organization: name, database: name }).strict(), cloudflare: z.object({ accountId: name }).strict(),
}).strict() }).strict();
export { configuration as BoatAccountAdmissionConfigurationSchema };
export function configuredBoatAccountAdmission(accountScope: string, billingOrg: string, env: NodeJS.ProcessEnv = process.env): BoatAccountAdmission | null {
  let parsed;
  try { parsed = configuration.safeParse(JSON.parse(env.WORKER_ADMISSION_CONFIG_JSON ?? "")); } catch { return null; }
  if (!parsed.success || parsed.data.profile.boat.accountScope !== accountScope || parsed.data.profile.boat.billingOrg !== billingOrg) return null;
  const config = parsed.data.registry;
  const client = new S3Client({ region: "auto", endpoint: config.endpoint, maxAttempts: 1, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  const readDocument = async (key: string, owner: string) => {
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
      if (!response.ETag || !response.Body || (response.ContentLength ?? Infinity) > 1024 * 1024) unavailable();
      return { state: openBoatAccountDocument(await response.Body.transformToString(), config.encryptionKey, owner), etag: response.ETag };
    } catch (error) { if ((error as any)?.name === "NoSuchKey") return null; return unavailable(); }
  };
  const store: BoatAccountStore = { readDocument, readAdmission: () => readDocument("admission/v1/account.json", "account-admission"),
    writeAdmission: async (ledger, etag) => {
      try {
        const response = await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: "admission/v1/account.json", IfMatch: etag,
          Body: sealBoatAccountDocument(ledger, config.encryptionKey), ContentType: "application/json" }), { abortSignal: AbortSignal.timeout(15_000) });
        if (!response.ETag) unavailable(); return response.ETag;
      } catch (error) {
        if ((error as any)?.$metadata?.httpStatusCode === 412) throw Object.assign(new Error("Shared account admission conflict"), { code: "DEV_REGISTRY_CONFLICT" });
        return unavailable();
      }
    } };
  return new BoatAccountAdmission(store, parsed.data.profile);
}

export class BoatAccountAdmission {
  constructor(private readonly store: BoatAccountStore, private readonly profile: Profile) {}
  private async read() {
    const document = await this.store.readAdmission(), ledger = document?.state as Ledger | undefined;
    if (!document || ledger?.version !== 1 || ledger.owner !== "account-admission" || ledger.account !== accountIdentity(this.profile) || !Array.isArray(ledger.reservations) || ledger.reservations.length > 5000) unavailable();
    const identities = new Set<string>();
    for (const row of ledger.reservations) {
      const identity = JSON.stringify([row.owner, row.generation, row.kind, row.computeId]);
      if (!["generation", "builder"].includes(row.kind) || !/^[a-f0-9]{24}$/.test(row.owner) || !z.string().uuid().safeParse(row.generation).success ||
        !Number.isFinite(Date.parse(row.createdAt)) || identities.has(identity) || row.releasedAt && !Number.isFinite(Date.parse(row.releasedAt)) ||
        row.snapshotReleasedAt && !Number.isFinite(Date.parse(row.snapshotReleasedAt)) || row.kind === "builder" && (!row.computeId ||
          (row.snapshotName ? row.computeId !== `snapshot:${row.snapshotName}` : !/^canary:[a-f0-9-]{36}$/.test(row.computeId)))) unavailable();
      identities.add(identity);
    }
    return { ledger, etag: document.etag };
  }
  async capacity(inventory: string[]) {
    const { ledger } = await this.read(), result = protectedBoatSnapshotCapacity(this.profile, inventory, ledger.reservations);
    if (ledger.reservations.some(row => row.kind === "builder" && !row.releasedAt)) unavailable();
    return result;
  }
  private identity(image: Image) {
    if (!z.string().uuid().safeParse(image.id).success || !z.string().uuid().safeParse(image.org_id).success || image.account_scope !== this.profile.boat.accountScope ||
      image.snapshot_name !== `zeros-org-${image.id.replaceAll("-", "")}`) unavailable();
    return { owner: digest(`zeros-custom-image:${image.org_id}`).slice(0, 24), generation: image.id, computeId: `snapshot:${image.snapshot_name}` };
  }
  private async change<Result>(update: (ledger: Ledger) => Result) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const { ledger, etag } = await this.read(), result = update(ledger);
      try { await this.store.writeAdmission(ledger, etag); return result; }
      catch (error) { if ((error as any)?.code !== "DEV_REGISTRY_CONFLICT") throw error; }
    }
    return unavailable();
  }
  async reserve(image: Image, inventory: string[]) {
    const identity = this.identity(image);
    return this.change(ledger => {
      protectedBoatSnapshotCapacity(this.profile, inventory, ledger.reservations, image.snapshot_name, "non-release");
      const previous = ledger.reservations.find(row => row.computeId === identity.computeId);
      if (previous && (previous.owner !== identity.owner || previous.generation !== image.id)) unavailable();
      const active = ledger.reservations.filter(row => row.kind === "builder" && !row.releasedAt && row !== previous);
      if (active.length >= (this.profile.admission?.maxBuilders ?? 1)) unavailable();
      const reservation: Reservation = { kind: "builder", ...identity, snapshotName: image.snapshot_name, capacityClass: "custom", createdAt: new Date(image.created_at).toISOString() };
      if (previous) Object.assign(previous, reservation, { releasedAt: undefined, snapshotReleasedAt: undefined }); else ledger.reservations.push(reservation);
      return reservation;
    });
  }
  async release(image: Image, proof: { computeDeleted: boolean; snapshotDeleted: boolean }) {
    if (!proof.computeDeleted) return;
    const identity = this.identity(image);
    await this.change(ledger => {
      const reservation = ledger.reservations.find(row => row.owner === identity.owner && row.generation === identity.generation && row.computeId === identity.computeId);
      if (!reservation) return;
      reservation.releasedAt ??= new Date().toISOString();
      if (proof.snapshotDeleted) reservation.snapshotReleasedAt ??= new Date().toISOString();
      ledger.reservations = ledger.reservations.filter(row => !row.releasedAt || row.snapshotName && !row.snapshotReleasedAt);
    });
  }
  async assertCanary(request: ReleaseCanaryRequest) {
    const owner = releaseWorkerOwner(request.channel), document = await this.store.readDocument(`release-workers/v1/${request.channel}.json`, owner), state = document?.state;
    const run = state?.releaseRuns?.find((value: any) => value.runId === request.runId);
    const bindings = ReleaseCanaryBindingsSchema.safeParse(run?.releaseCanaryBindings);
    const binding = bindings.success ? bindings.data.find(row => row.kind === request.kind) : undefined;
    const job = run?.canaries?.find((value: any) => value.id === request.operationId), row = state?.resources?.images?.find((value: any) => value.agentQualificationId === request.operationId);
    if (!state || state.owner !== owner || !Number.isFinite(state.lease?.expiresAt) || state.lease.expiresAt <= Date.now() ||
      run?.actorUserId !== request.ownerUserId || run.sourceSha !== request.sourceSha || run.qualificationProfile !== request.qualificationProfile ||
      !binding || binding.credentialId !== request.credentialId || binding.credentialRevision !== request.credentialRevision || binding.designationId !== request.designationId || binding.model !== request.model ||
      job?.kind !== request.kind || job.model !== request.model || job.qualificationProfile !== request.qualificationProfile || !["starting", "running"].includes(job.phase) ||
      job.credentialId !== request.credentialId || job.credentialRevision !== request.credentialRevision || job.designationId !== request.designationId ||
      job.image?.snapshotId !== request.target.snapshotId || job.image?.sourceCommit !== request.sourceSha || job.image?.buildSha256 !== request.target.buildSha256 ||
      row?.purpose !== "native-agent-qualification" || row.sourceImage !== request.target.snapshotId || row.sourceCommit !== request.sourceSha ||
      row.builder?.id !== request.target.id || row.builder.deleted || row.builder.retiredAt || row.builder.deleteRequested || !row.machineAttestationStarted || !row.nativeDispatchStarted)
      unavailable("Release canary target is not a fenced disposable allocation from this exact release run");
    if (row.snapshotPolicyVersion !== undefined) {
      if (row.snapshotPolicyVersion !== 1 || row.builderIntent?.body?.snapshots !== false ||
        row.snapshotPolicyObserved?.version !== 1 || row.snapshotPolicyObserved.targetId !== request.target.id || row.snapshotPolicyObserved.snapshots !== false ||
        !Number.isFinite(Date.parse(row.snapshotPolicyObserved.observedAt))) unavailable("Release canary snapshots-off policy is unconfirmed");
      return { snapshotsOffRequired: true as const };
    }
    return undefined;
  }
  async assertCanaryRetirement(audit: ReleaseCanaryRetirementAudit, input: ReleaseCanaryRetirement, organizationId: string) {
    const owner = releaseWorkerOwner(audit.channel), document = await this.store.readDocument(`release-workers/v1/${audit.channel}.json`, owner);
    const { ledger } = await this.read();
    return releaseCanaryRetirementJournal(document?.state, ledger, this.profile, audit, input, organizationId);
  }
}
