import { createHash, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { refuseRetiredReleaseWorker } from "./release-worker-retirement.js";
import { withSystemTx, type Tx } from "../db.js";
import { loadReleaseCanaryBoatConfig, type Config } from "../config.js";
import { cloudAgentCredentialKeys } from "./agent-credentials.js";
import { type CloudAgentCredentialKeys, type CloudAgentCredentialKind } from "./agent-credential-envelope.js";
import type { startNativeDevCanary } from "./dev-native-canary.js";
import type { prepareNativeCanaryAccess } from "./native-canary-access.js";
import { configuredBoatAccountAdmission, type BoatAccountAdmission } from "./boat-account-admission.js";
import { RELEASE_CANARY_KINDS, RELEASE_CANARY_UPLOAD_FORBIDDEN, ReleaseCanaryIdentitySchema,
  ReleaseCanaryAdmissionSchema, ReleaseCanaryRetirementSchema, ReleaseCanaryRetirementAuditSchema, NativeCanaryDeletionOperationSchema, NativeCanaryStorageOperationSchema, NativeCanaryStorageProgressSchema } from "./release-canary-contract.js";

const uuid = z.string().uuid();
const model = z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/);
const kind = z.enum(RELEASE_CANARY_KINDS);
const identity = ReleaseCanaryIdentitySchema, admission = ReleaseCanaryAdmissionSchema;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const action = "cloud.release_canary.";
function unavailable(message = "Release canary admission is unavailable"): never { throw new HttpError(409, "release_canary_unavailable", message); }
type Scope = Pick<z.infer<typeof identity>, "ownerUserId" | "organizationId" | "channel" | "sourceSha" | "repository">;
export type ReleaseCanaryRequest = z.infer<typeof admission>;
type Credential = { id: string; owner_user_id: string; kind: CloudAgentCredentialKind; revision: string; current_version: number; revoked_at: Date | null };
type Audit = { id: string; action: string; subject: Record<string, any> };
export type ReleaseCanaryConfiguration = Scope & { tokenSha256: string; keys: CloudAgentCredentialKeys; admission: BoatAccountAdmission; boat: { apiKey: string; apiUrl: string; billingOrg: string } };
export type ReleaseCanaryDesignationConfiguration = Pick<Scope, "ownerUserId" | "organizationId" | "channel">;

export function releaseCanaryDesignationConfiguration(config: Config, env: NodeJS.ProcessEnv = process.env): ReleaseCanaryDesignationConfiguration | null {
  if (config.deploymentChannel === "development" || config.databaseMaintenanceMode) return null;
  const selected = identity.pick({ ownerUserId: true, organizationId: true, channel: true }).safeParse({
    ownerUserId: env.RUNTIME_QUALIFICATION_ACTOR_USER_ID, organizationId: env.WORKER_CANARY_ORGANIZATION_ID, channel: config.deploymentChannel,
  });
  return selected.success ? selected.data : null;
}


function bindScope(value: Scope, scope: Scope) {
  if (["ownerUserId", "organizationId", "channel", "sourceSha", "repository"].some(key => value[key as keyof Scope] !== scope[key as keyof Scope])) unavailable("Release canary scope is invalid");
}
export function releaseCanaryRequest(value: unknown, scope: Scope) {
  const parsed = admission.safeParse(value);
  if (!parsed.success) unavailable("Release canary request is invalid");
  const request = parsed.data; bindScope(request, scope);
  if (request.operationId !== request.target.attempt || request.target.sourceCommit !== request.sourceSha ||
    (request.channel === "alpha" ? request.branch !== "main" : !/^release\/\d+\.\d+\.\d+$/.test(request.branch))) unavailable("Release canary target is invalid");
  return request;
}
export function releaseCanaryDesignation(request: Pick<ReleaseCanaryRequest, "credentialId" | "credentialRevision" | "designationId" | "kind" | "model" | "ownerUserId" | "channel">,
  credential: Credential | undefined, designation: Audit | undefined) {
  const consent = designation?.subject;
  if (!credential || credential.id !== request.credentialId || credential.owner_user_id !== request.ownerUserId || credential.kind !== request.kind ||
    Number(credential.revision) !== request.credentialRevision || credential.revoked_at || designation?.id !== request.designationId ||
    consent?.enabled !== true || consent.credentialId !== request.credentialId || consent.credentialRevision !== request.credentialRevision ||
    consent.channel !== request.channel || consent.allowanceOwnerUserId !== request.ownerUserId || !Array.isArray(consent.models) || !consent.models.includes(request.model)) {
    unavailable("The exact owner credential/model is not designated for release canaries");
  }
  return credential;
}
export function releaseCanaryConfiguration(config: Config, env: NodeJS.ProcessEnv = process.env): ReleaseCanaryConfiguration | null {
  if (env.ZEROS_RELEASE_CANARIES_ENABLED !== "true" || config.deploymentChannel === "development" || config.databaseMaintenanceMode) return null;
  const keys = cloudAgentCredentialKeys(config.cloudAgentCredentials ?? config.cloudWorkspaces), profile = config.cloudWorkspaces;
  const boat = profile?.provider === "boat" && profile.boat
    ? { apiKey: profile.apiKey, apiUrl: profile.apiUrl, billingOrg: profile.boat.billingOrg, accountScope: profile.boat.accountScope }
    : profile ? null : loadReleaseCanaryBoatConfig(env);
  const selected = identity.omit({ version: true, qualificationProfile: true }).safeParse({ ownerUserId: env.RUNTIME_QUALIFICATION_ACTOR_USER_ID,
    organizationId: env.WORKER_CANARY_ORGANIZATION_ID, channel: config.deploymentChannel, sourceSha: env.RAILWAY_GIT_COMMIT_SHA, repository: env.WORKER_CANARY_REPOSITORY });
  if (!selected.success || !keys || !boat?.billingOrg || !boat.apiKey || !env.WORKER_CANARY_ADMISSION_TOKEN || env.WORKER_CANARY_ADMISSION_TOKEN.length < 32) return null;
  const sharedAdmission = configuredBoatAccountAdmission(boat.accountScope, boat.billingOrg, env);
  if (!sharedAdmission) return null;
  return { ...selected.data, keys, admission: sharedAdmission, tokenSha256: hash(env.WORKER_CANARY_ADMISSION_TOKEN), boat: { apiKey: boat.apiKey, apiUrl: boat.apiUrl, billingOrg: boat.billingOrg } };
}
type NativeDeps = {
  phase: string;
  transition(phase: string, versions?: Record<string, number>): Promise<void>;
  read: Parameters<typeof prepareNativeCanaryAccess>[0];
  renew(): Promise<void>;
  assertFresh(): Promise<void>;
  observeStarted(): Promise<boolean>;
  start(input: unknown, renewal: Parameters<typeof startNativeDevCanary>[3]): Promise<void>;
};
export async function runReleaseCanaryAdmission(_request: ReleaseCanaryRequest, _deps: NativeDeps): Promise<{ started: true }> {
  refuseRetiredReleaseWorker();
}

export class DatabaseReleaseCanaryDesignationService {
  constructor(protected readonly pool: pg.Pool, protected readonly config: ReleaseCanaryDesignationConfiguration) {}
  protected async owner(tx: Tx, userId: string) {
    if (userId !== this.config.ownerUserId || (await tx.query(`SELECT 1 FROM users account JOIN organization_members member ON member.user_id=account.id
      JOIN organizations organization ON organization.id=member.org_id WHERE account.id=$1 AND account.staff_role='platform_owner' AND account.auth_status='active'
      AND account.deleted_at IS NULL AND member.org_id=$2 AND member.role='owner' AND organization.deleted_at IS NULL
      AND cloud_workspace_pro_user_live(account.id) FOR SHARE OF account,member,organization`, [userId, this.config.organizationId])).rowCount !== 1) unavailable("Release canary owner allowance is unavailable");
  }
  protected async credential(tx: Tx, id: string) {
    return (await tx.query<Credential>("SELECT id,owner_user_id,kind,revision::text,current_version,revoked_at FROM cloud_agent_credentials WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [id, this.config.ownerUserId])).rows[0];
  }
  protected async designation(tx: Tx, id: string) {
    return (await tx.query<Audit>("SELECT id::text,action,subject FROM audit_log WHERE org_id=$1 AND actor_id=$2 AND action=$3 AND subject->>'credentialId'=$4 ORDER BY id DESC LIMIT 1",
      [this.config.organizationId, this.config.ownerUserId, `${action}designated`, id])).rows[0];
  }
  protected async append(tx: Tx, state: string, subject: Record<string, unknown>) {
    return (await tx.query<{ id: string }>("INSERT INTO audit_log(org_id,actor_id,action,subject) VALUES($1,$2,$3,$4) RETURNING id::text",
      [this.config.organizationId, this.config.ownerUserId, `${action}${state}`, JSON.stringify(subject)])).rows[0]!.id;
  }
  async readDesignation(userId: string, id: string) {
    if (!uuid.safeParse(id).success) unavailable();
    return withSystemTx(this.pool, async tx => {
      await this.owner(tx, userId); const credential = await this.credential(tx, id);
      if (!credential || credential.revoked_at || !kind.safeParse(credential.kind).success) unavailable();
      const selected = await this.designation(tx, id);
      const enabled = selected?.subject.enabled === true && selected.subject.credentialId === id &&
        selected.subject.credentialRevision === Number(credential.revision) && selected.subject.channel === this.config.channel &&
        selected.subject.allowanceOwnerUserId === userId && z.array(model).min(1).max(3).safeParse(selected.subject.models).success;
      const lastUsed = (await tx.query<{ created_at: Date }>(`SELECT created_at FROM audit_log WHERE org_id=$1 AND actor_id=$2
        AND action=ANY($3::text[]) AND subject->>'credentialId'=$4 ORDER BY id DESC LIMIT 1`,
      [this.config.organizationId, userId, [`${action}started`], id])).rows[0]?.created_at;
      return { designationId: selected?.id ?? "0", credentialRevision: Number(credential.revision), enabled,
        models: enabled ? selected!.subject.models as string[] : [], lastUsedAt: lastUsed ? new Date(lastUsed).toISOString() : null };
    });
  }
  async designate(userId: string, id: string, value: unknown) {
    const parsed = z.object({ operationId: uuid, expectedDesignationId: z.string().regex(/^(?:0|[1-9]\d*)$/), credentialRevision: z.number().int().positive().safe(),
      enabled: z.boolean(), models: z.array(model).min(1).max(3) }).strict().safeParse(value);
    if (!parsed.success || !uuid.safeParse(id).success) unavailable("Release canary designation is invalid");
    return withSystemTx(this.pool, async tx => {
      await this.owner(tx, userId); const credential = await this.credential(tx, id), selected = await this.designation(tx, id), input = parsed.data;
      if (!credential || credential.revoked_at || !kind.safeParse(credential.kind).success || Number(credential.revision) !== input.credentialRevision) unavailable();
      const subject = { ...input, credentialId: id, channel: this.config.channel, allowanceOwnerUserId: userId, requestSha256: hash(JSON.stringify(input)) };
      if (selected?.subject.operationId === input.operationId) {
        if (selected.subject.requestSha256 !== subject.requestSha256) unavailable("Release canary designation operation changed");
        return { designationId: selected.id, enabled: input.enabled };
      }
      if ((selected?.id ?? "0") !== input.expectedDesignationId) unavailable("Release canary designation changed");
      return { designationId: await this.append(tx, "designated", subject), enabled: input.enabled };
    });
  }
}

export class DatabaseReleaseCanaryService extends DatabaseReleaseCanaryDesignationService {
  constructor(pool: pg.Pool, private readonly releaseConfig: ReleaseCanaryConfiguration) { super(pool, releaseConfig); }
  private auth(authorization: string | undefined) {
    if (!authorization?.startsWith("Bearer ") || !timingSafeEqual(Buffer.from(hash(authorization.slice(7)), "hex"), Buffer.from(this.releaseConfig.tokenSha256, "hex")))
      throw new HttpError(401, "release_canary_unauthorized", "Release canary authentication is required");
  }
  async preflight(_value: unknown, authorization: string | undefined): Promise<never> {
    this.auth(authorization);
    refuseRetiredReleaseWorker();
  }
  private async boatReply(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
    try {
      const reply = await fetch(`${this.releaseConfig.boat.apiUrl.replace(/\/$/, "")}${route}`, { method, redirect: "error", signal: AbortSignal.timeout(55_000),
        headers: { authorization: `Bearer ${this.releaseConfig.boat.apiKey}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (method === "PUT" && route.endsWith("/files") && reply.status === 403)
        throw new HttpError(409, "release_canary_prelaunch_forbidden", RELEASE_CANARY_UPLOAD_FORBIDDEN);
      if (method === "GET" && reply.status === 404) return { status: 404, body: null };
      if (!reply.ok) unavailable();
      const bytes = await reply.text(); if (bytes.length > 1024 * 1024) unavailable();
      return { status: reply.status, body: JSON.parse(bytes) };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      unavailable();
    }
  }
  private async boat(method: string, route: string, body?: unknown): Promise<any> {
    const result = await this.boatReply(method, route, body);
    if (result.status === 404) unavailable();
    return result.body;
  }
  async retire(value: unknown, authorization: string | undefined) {
    this.auth(authorization);
    const input = ReleaseCanaryRetirementSchema.safeParse(value);
    if (!input.success) unavailable("Release canary retirement request is invalid");
    const locked = <Result>(callback: (tx: Tx, last: Audit) => Promise<Result>) => withSystemTx(this.pool, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,93147))", [`release-canary:${input.data.operationId}`]);
      await this.owner(tx, this.config.ownerUserId);
      const last = (await tx.query<Audit>(`SELECT id::text,action,subject FROM audit_log WHERE org_id=$1 AND actor_id=$2 AND action=ANY($3::text[])
        AND subject->>'operationId'=$4 ORDER BY id DESC LIMIT 1`, [this.config.organizationId, this.config.ownerUserId,
        ["reserved", "preparing", "dispatched", "started", "storage_retired", "retired"].map(phase => `${action}${phase}`), input.data.operationId])).rows[0];
      if (!last) unavailable("Release canary retirement requires the original immutable audit");
      const parsed = ReleaseCanaryRetirementAuditSchema.safeParse(last.subject);
      if (!parsed.success || parsed.data.operationId !== input.data.operationId || parsed.data.allowanceOwnerUserId !== this.config.ownerUserId ||
        parsed.data.channel !== this.config.channel || parsed.data.repository !== this.releaseConfig.repository) unavailable("Release canary retirement scope is invalid");
      const credential = (await tx.query<{ owner_user_id: string }>("SELECT owner_user_id FROM cloud_agent_credentials WHERE id=$1 FOR UPDATE", [parsed.data.credentialId])).rows[0];
      if (credential && credential.owner_user_id !== this.config.ownerUserId) unavailable("Release canary retirement credential ownership changed");
      if ((await tx.query(`SELECT 1 FROM cloud_workspace_provider_bindings WHERE provider='boat' AND provider_resource_id=$1
        UNION ALL SELECT 1 FROM cloud_workspace_provider_operations WHERE provider='boat' AND resource_id=$1
        UNION ALL SELECT 1 FROM cloud_computer_images WHERE builder_id=$1 OR verifier_id=$1 LIMIT 1`, [parsed.data.targetId])).rowCount !== 0)
        unavailable("Release canary retirement cannot use a workspace allocation");
      return callback(tx, last);
    });
    const original = await locked(async (_tx, last) => last), audited = ReleaseCanaryRetirementAuditSchema.parse(original.subject);
    const journal = async () => {
      try { return await this.releaseConfig.admission.assertCanaryRetirement(audited, input.data, this.config.organizationId); }
      catch { unavailable("Release canary retirement journal proof is unconfirmed"); }
    };
    const retained = await journal(), observed = await this.boatReply("GET", `/deletion-operations/${input.data.deletionOperationId}`);
    const raw = observed.body?.operation;
    const pending = retained.physicalCleanup === undefined && retained.storageRetirement !== undefined;
    const projection = raw && { id: raw.id, kind: raw.kind, targetId: raw.targetId, status: raw.status, requestedAt: raw.requestedAt };
    const progress = pending && ["pending", "processing"].includes(raw?.status);
    const operation = progress ? NativeCanaryStorageProgressSchema.safeParse(raw && { ...projection, stage: raw.stage })
      : pending ? NativeCanaryStorageOperationSchema.safeParse(raw && { ...projection, stage: raw.stage, expectedBy: raw.expectedBy ?? null })
      : NativeCanaryDeletionOperationSchema.safeParse(raw && { ...projection, completedAt: raw.completedAt });
    const operationObservedAt = new Date().toISOString();
    const cleanup = retained.physicalCleanup ?? retained.storageRetirement;
    if (observed.status !== 200 || !operation.success || operation.data.id !== input.data.deletionOperationId || operation.data.targetId !== retained.targetId ||
      Date.parse(operation.data.requestedAt) < retained.intentAt || Date.parse(operation.data.requestedAt) > Date.parse(operationObservedAt) ||
      (pending ? raw.completedAt != null : !("completedAt" in operation.data) || Date.parse(operation.data.completedAt) > Date.parse(operationObservedAt)) ||
      !cleanup || (progress ? operation.data.requestedAt !== cleanup.operation.requestedAt : JSON.stringify(operation.data) !== JSON.stringify(cleanup.operation)))
      unavailable("Release canary retirement physical deletion is unconfirmed");
    const sandbox = await this.boatReply("GET", `/sandboxes/${retained.targetId}`), unavailableObservedAt = new Date().toISOString();
    if (sandbox.status !== 404) unavailable("Release canary retirement sandbox is still available");
    const again = await journal();
    if (again.provenanceSha256 !== retained.provenanceSha256 || JSON.stringify(again.physicalCleanup ?? again.storageRetirement) !== JSON.stringify(cleanup))
      unavailable("Release canary retirement journal identity changed");
    return locked(async (tx, last) => {
      if (last.subject.requestSha256 !== audited.requestSha256) unavailable("Release canary retirement operation identity changed");
      if (last.action === `${action}retired`) {
        const previous = NativeCanaryDeletionOperationSchema.safeParse(last.subject.retirement?.operation);
        if (last.subject.retirement?.deletionOperationId !== input.data.deletionOperationId ||
          last.subject.retirement.provenanceSha256 !== retained.provenanceSha256 || !previous.success ||
          JSON.stringify(previous.data) !== JSON.stringify(operation.data))
          unavailable("Release canary retirement terminal proof changed");
        return { retired: true as const };
      }
      if (last.action === `${action}storage_retired`) {
        const previous = NativeCanaryStorageOperationSchema.safeParse(last.subject.retirement?.operation);
        if (last.subject.retirement?.version !== 2 || last.subject.retirement.deletionOperationId !== input.data.deletionOperationId ||
          last.subject.retirement.provenanceSha256 !== retained.provenanceSha256 || !previous.success ||
          previous.data.requestedAt !== operation.data.requestedAt) unavailable("Release canary retirement terminal proof changed");
        if (pending && (progress || JSON.stringify(previous.data) === JSON.stringify(operation.data))) return { retired: true as const, storagePending: true as const };
      }
      if (last.id !== original.id || JSON.stringify(last.subject) !== JSON.stringify(original.subject)) unavailable("Release canary retirement phase changed; reconcile before retrying");
      await this.append(tx, pending ? "storage_retired" : "retired", { ...last.subject, retirement: { version: pending ? 2 : 1, deletionOperationId: input.data.deletionOperationId,
        ...(pending ? { storage: { status: "pending", physicalBytes: "unmeasured" } } : {}),
        ...(progress ? { progress: { operation: operation.data, operationObservedAt } } : {}),
        targetId: retained.targetId, operation: progress ? cleanup.operation : operation.data,
        operationObservedAt: progress ? cleanup.operationObservedAt : operationObservedAt, unavailableObservedAt, provenanceSha256: retained.provenanceSha256 } });
      return pending ? { retired: true as const, storagePending: true as const } : { retired: true as const };
    });
  }
  async admit(_value: unknown, authorization: string | undefined): Promise<never> {
    this.auth(authorization);
    refuseRetiredReleaseWorker();
  }
}
