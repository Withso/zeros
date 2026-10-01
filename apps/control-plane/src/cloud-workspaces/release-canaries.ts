import { createHash, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { loadReleaseCanaryBoatConfig, type Config } from "../config.js";
import { cloudAgentCredentialKeys } from "./agent-credentials.js";
import { openCloudAgentCredential, type CloudAgentCredentialKeys, type CloudAgentCredentialKind } from "./agent-credential-envelope.js";
import { DatabaseCodexAuthRenewal } from "./codex-auth-renewal.js";
import { DevCanaryTargetSchema, startNativeDevCanary } from "./dev-native-canary.js";
import { prepareNativeCanaryAccess } from "./native-canary-access.js";
import { configuredBoatAccountAdmission, type BoatAccountAdmission } from "./boat-account-admission.js";
import { RELEASE_CANARY_KINDS, RELEASE_CANARY_MODELS, ReleaseCanaryConnectionSchema, type ReleaseCanaryConnection } from "./release-canary-contract.js";

const uuid = z.string().uuid(), sha = z.string().regex(/^[a-f0-9]{40}$/), counter = z.string().regex(/^[1-9]\d*$/);
const model = z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/);
const kind = z.enum(RELEASE_CANARY_KINDS);
const connection = ReleaseCanaryConnectionSchema;
const identity = z.object({ version: z.literal(1), ownerUserId: uuid, organizationId: uuid, channel: z.enum(["alpha", "beta", "production"]),
  sourceSha: sha, repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), qualificationProfile: z.enum(["smoke", "full"]) }).strict();
const admission = identity.extend({ operationId: uuid, runId: counter, runAttempt: counter, branch: z.string(), ...connection.shape, target: DevCanaryTargetSchema }).strict();
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

type DiscoveryCredential = Credential & { designation_id: string; designation_action: string; designation_subject: Audit["subject"] };
export function discoverReleaseCanaryConnections(rows: DiscoveryCredential[], scope: ReleaseCanaryDesignationConfiguration, profile: "smoke" | "full"): ReleaseCanaryConnection[] {
  if (rows.length > 100) unavailable("Release canary designation inventory exceeds its bound");
  const active = rows.filter(row => {
    const consent = row.designation_subject;
    return row.owner_user_id === scope.ownerUserId && !row.revoked_at && kind.safeParse(row.kind).success &&
      row.designation_action === `${action}designated` && counter.safeParse(row.designation_id).success &&
      consent?.enabled === true && consent.credentialId === row.id && consent.credentialRevision === Number(row.revision) &&
      consent.channel === scope.channel && consent.allowanceOwnerUserId === scope.ownerUserId;
  });
  return RELEASE_CANARY_KINDS.map(selectedKind => {
    const matches = active.filter(row => row.kind === selectedKind);
    if (matches.length !== 1) unavailable(`Release canary designation ${matches.length ? "ambiguous" : "missing"} for ${selectedKind}`);
    const selected = matches[0]!, models = z.array(model).min(1).max(3).safeParse(selected.designation_subject.models), pinned = RELEASE_CANARY_MODELS[selectedKind];
    if (!models.success || new Set(models.data).size !== models.data.length || profile === "smoke" && !models.data.includes(pinned))
      unavailable(`Release canary model not approved for ${selectedKind}`);
    const approvedModel = models.data.includes(pinned) ? pinned : [...models.data].sort()[0]!;
    const parsed = connection.safeParse({ kind: selectedKind, credentialId: selected.id, credentialRevision: Number(selected.revision),
      designationId: selected.designation_id, model: approvedModel });
    if (!parsed.success) unavailable(`Release canary designation missing for ${selectedKind}`);
    return parsed.data;
  });
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
export async function runReleaseCanaryAdmission(request: ReleaseCanaryRequest, deps: NativeDeps) {
  if (["dispatched", "started"].includes(deps.phase)) {
    if (!await deps.observeStarted()) unavailable("Release canary dispatch requires reconciliation before retry");
    if (deps.phase !== "started") await deps.transition("started");
    return { started: true as const };
  }
  if (deps.phase !== "reserved") unavailable("Release canary credential preparation requires reconciliation before retry");
  await deps.transition("preparing"); await deps.assertFresh();
  const access = await prepareNativeCanaryAccess(deps.read, deps.renew, Date.now, request.qualificationProfile === "full" ? 42 * 60_000 : 120_000);
  await deps.transition("dispatched", { beforeVersion: access.before.credential.current_version });
  await deps.assertFresh();
  const deadline = Math.min(Date.now() + (request.qualificationProfile === "full" ? 40 : 14) * 60_000,
    ...(access.before.material.kind === "codex-chatgpt" && access.renewedCodex ? [access.before.material.expiresAt * 1000, access.renewedCodex.expiresAt * 1000] : []));
  await deps.start({ version: 1, qualificationProfile: request.qualificationProfile, expiresAtMs: deadline, sourceCommit: request.sourceSha,
    buildSha256: request.target.buildSha256, model: request.model, material: access.before.material,
    ...(access.renewedCodex ? { renewedCodex: access.renewedCodex } : {}) }, access.renewal);
  await deps.transition("started");
  return { started: true as const };
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
  protected async consent(tx: Tx, request: Parameters<typeof releaseCanaryDesignation>[0]) {
    await this.owner(tx, request.ownerUserId);
    return releaseCanaryDesignation(request, await this.credential(tx, request.credentialId), await this.designation(tx, request.credentialId));
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
  async preflight(value: unknown, authorization: string | undefined) {
    this.auth(authorization);
    const parsed = identity.extend({ runId: counter, runAttempt: counter, branch: z.string() }).strict().safeParse(value);
    if (!parsed.success) unavailable("Release canary preflight is invalid");
    bindScope(parsed.data, this.releaseConfig);
    if (parsed.data.channel === "alpha" ? parsed.data.branch !== "main" : !/^release\/\d+\.\d+\.\d+$/.test(parsed.data.branch)) unavailable("Release canary preflight branch is invalid");
    const connections = await withSystemTx(this.pool, async tx => {
      await this.owner(tx, parsed.data.ownerUserId);
      const rows = (await tx.query<DiscoveryCredential>(`SELECT credential.id,credential.owner_user_id,credential.kind,credential.revision::text,
        credential.current_version,credential.revoked_at,designation.id::text AS designation_id,designation.action AS designation_action,
        designation.subject AS designation_subject FROM cloud_agent_credentials credential JOIN LATERAL (
          SELECT id,action,subject FROM audit_log WHERE org_id=$2 AND actor_id=$1 AND action=$3
          AND subject->>'credentialId'=credential.id::text ORDER BY id DESC LIMIT 1
        ) designation ON true WHERE credential.owner_user_id=$1 AND credential.kind=ANY($4::text[]) AND credential.revoked_at IS NULL
        AND designation.subject->>'enabled'='true' ORDER BY credential.id LIMIT 101 FOR UPDATE OF credential`,
      [this.config.ownerUserId, this.config.organizationId, `${action}designated`, RELEASE_CANARY_KINDS])).rows;
      return discoverReleaseCanaryConnections(rows, this.config, parsed.data.qualificationProfile);
    });
    return { ready: true as const, ...parsed.data, connections };
  }
  private async boat(method: string, route: string, body?: unknown): Promise<any> {
    const reply = await fetch(`${this.releaseConfig.boat.apiUrl.replace(/\/$/, "")}${route}`, { method, redirect: "error", signal: AbortSignal.timeout(55_000),
      headers: { authorization: `Bearer ${this.releaseConfig.boat.apiKey}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!reply.ok) unavailable();
    const bytes = await reply.text(); if (bytes.length > 1024 * 1024) unavailable();
    return JSON.parse(bytes);
  }
  async admit(value: unknown, authorization: string | undefined) {
    this.auth(authorization); const request = releaseCanaryRequest(value, this.releaseConfig), requestSha256 = hash(JSON.stringify(request));
    const latest = (tx: Tx) => tx.query<Audit>("SELECT id::text,action,subject FROM audit_log WHERE org_id=$1 AND actor_id=$2 AND action LIKE $3 AND subject->>'operationId'=$4 ORDER BY id DESC LIMIT 1",
      [this.config.organizationId, this.config.ownerUserId, `${action}%`, request.operationId]);
    const locked = async <Result>(callback: (tx: Tx, last: Audit | undefined) => Promise<Result>) => withSystemTx(this.pool, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,93147))", [`release-canary:${request.operationId}`]);
      await this.consent(tx, request); const last = (await latest(tx)).rows[0];
      if (last && last.subject.requestSha256 !== requestSha256) unavailable("Release canary operation identity changed");
      if ((await tx.query(`SELECT 1 FROM audit_log pending WHERE pending.org_id=$1 AND pending.actor_id=$2 AND pending.action=ANY($3::text[])
        AND pending.subject->>'credentialId'=$4 AND pending.subject->>'operationId'<>$5 AND NOT EXISTS (
          SELECT 1 FROM audit_log settled WHERE settled.org_id=pending.org_id AND settled.actor_id=pending.actor_id
          AND settled.subject->>'operationId'=pending.subject->>'operationId' AND settled.action=ANY($6::text[]) AND settled.id>pending.id) LIMIT 1`,
      [this.config.organizationId, this.config.ownerUserId, ["preparing", "dispatched"].map(state => `${action}${state}`), request.credentialId,
        request.operationId, ["reserved", "preparing", "dispatched", "started"].map(state => `${action}${state}`)])).rowCount !== 0)
        unavailable("Release canary credential requires reconciliation before another operation");
      return callback(tx, last);
    });
    const summary = { operationId: request.operationId, requestSha256, credentialId: request.credentialId, credentialRevision: request.credentialRevision,
      designationId: request.designationId, kind: request.kind, model: request.model, qualificationProfile: request.qualificationProfile, channel: request.channel,
      sourceSha: request.sourceSha, repository: request.repository, runId: request.runId, runAttempt: request.runAttempt,
      targetId: request.target.id, imageRef: `boat:${request.target.snapshotId}@sha256:${request.target.buildSha256}`, allowanceOwnerUserId: request.ownerUserId };
    let phase = await locked(async (tx, last) => {
      if (last) return last.action.slice(action.length);
      await this.append(tx, "reserved", summary); return "reserved";
    });
    const transition = async (next: string, versions: Record<string, number> = {}) => {
      await locked(async (tx, last) => {
        if (last?.action !== `${action}${phase}`) unavailable("Release canary operation requires reconciliation");
        await this.append(tx, next, { ...summary, ...versions }); phase = next;
      });
    };
    const read = () => withSystemTx(this.pool, async tx => {
      const credential = await this.consent(tx, request), version = (await tx.query("SELECT * FROM cloud_agent_credential_versions WHERE credential_id=$1 AND version=$2", [credential.id, credential.current_version])).rows[0];
      if (!version) unavailable();
      const material = openCloudAgentCredential({ nonce: version.nonce, ciphertext: version.ciphertext, authTag: version.auth_tag },
        { credentialId: credential.id, ownerUserId: credential.owner_user_id, kind: credential.kind, version: credential.current_version, keyVersion: version.key_version }, this.releaseConfig.keys.keys);
      if (material.kind === "codex-chatgpt" && material.refreshToken) unavailable();
      return { credential, material };
    });
    const renewal = new DatabaseCodexAuthRenewal(this.pool, this.releaseConfig.keys);
    const renew = async () => {
      const delay = await withSystemTx(this.pool, async tx => {
        await this.consent(tx, request);
        const row = (await tx.query<{ delay_ms: number }>("SELECT greatest(0,ceil(extract(epoch FROM (refresh_after-clock_timestamp()))*1000)) AS delay_ms FROM cloud_codex_auth_caches WHERE credential_id=$1 AND state='ready'", [request.credentialId])).rows[0];
        return row?.delay_ms ?? 0;
      });
      if (delay > 61_000) unavailable();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay + 100));
      const reservation = await withSystemTx(this.pool, async tx => renewal.reserve(tx, await this.consent(tx, request), true));
      if (!reservation) unavailable(); await renewal.complete(reservation);
    };
    const command = async (script: string) => {
      const result = await this.boat("POST", `/sandboxes/${request.target.id}/commands`, { command: script, timeoutSeconds: 25 });
      if (result.exitCode !== 0 || result.timedOut) unavailable(); return String(result.stdout);
    };
    const assertFresh = async () => {
      await this.releaseConfig.admission.assertCanary(request);
      await withSystemTx(this.pool, async tx => {
        await this.consent(tx, request);
        if ((await tx.query(`SELECT 1 FROM cloud_workspace_provider_bindings WHERE provider='boat' AND provider_resource_id=$1
          UNION ALL SELECT 1 FROM cloud_workspace_provider_operations WHERE provider='boat' AND resource_id=$1
          UNION ALL SELECT 1 FROM cloud_computer_images WHERE builder_id=$1 OR verifier_id=$1 LIMIT 1`, [request.target.id])).rowCount !== 0) unavailable("Release canaries cannot use a workspace allocation");
      });
      const observed = await this.boat("GET", `/sandboxes/${request.target.id}`);
      if (observed.sandbox?.id !== request.target.id || observed.sandbox?.team?.id !== this.releaseConfig.boat.billingOrg) unavailable();
      const machine = JSON.parse(await command(`sudo -n /usr/bin/python3 - <<'PY'\nimport pathlib,json\np=pathlib.Path('/srv/zeros-qualification/machine-${request.operationId.replaceAll("-", "")}/result.json')\nassert p.is_file() and not p.is_symlink() and p.stat().st_size<1024\nprint(json.dumps({'qualified':json.loads(p.read_text()).get('qualified') is True}))\nPY`));
      if (machine.qualified !== true) unavailable("Release canary machine attestation is unconfirmed");
    };
    return runReleaseCanaryAdmission(request, { phase, transition, read, renew, assertFresh,
      observeStarted: async () => { await assertFresh(); return JSON.parse(await command(`sudo -n /usr/bin/python3 - <<'PY'\nimport pathlib,json\np=pathlib.Path('/srv/zeros-qualification/native-${request.operationId.replaceAll("-", "")}/runner.py')\nprint(json.dumps({'started':p.is_file() and not p.is_symlink()}))\nPY`)).started === true; },
      start: (input, proof) => startNativeDevCanary({ command, upload: async (file, contents) => {
        const result = await this.boat("PUT", `/sandboxes/${request.target.id}/files`, { path: file, encoding: "base64", content: contents.toString("base64") });
        if (result.size !== contents.length) unavailable();
      } }, request.target, input, proof, { deadlineSeconds: request.qualificationProfile === "full" ? 2400 : 420 }),
    });
  }
}
