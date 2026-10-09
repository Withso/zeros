import { createHash, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../authz.js";
import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import {
  CloudAgentCredentialMaterialSchema, openCredentialBytes, sealCredentialBytes,
  openCloudAgentCredential, type CloudAgentCredentialKind, type CloudAgentCredentialEnvelope, type CloudAgentCredentialKeys,
} from "./agent-credential-envelope.js";
import { CloudAgentAccessMaterialSchema, CloudAgentBootScopeSchema, CloudAgentInitialAdoptionsSchema, type CloudAgentAccessMaterial, type CloudAgentBootScope } from "./agent-boot-contract.js";

const purpose = "zeros-cloud-agent-boot-access-v1";
const revision = z.number().int().positive().safe();
const bindingSchema = CloudAgentBootScopeSchema.extend({
  fundingScope: z.literal("workspace-roles-v1"), cacheRevision: revision,
  provider: z.enum(["claude", "codex", "cursor"]),
  kind: z.enum(["claude-api-key", "claude-setup-token", "codex-api-key", "codex-chatgpt", "cursor-api-key"]),
  credentialId: z.string().uuid(), credentialRevision: revision, connectionRevision: revision,
  adoptionId: z.string().uuid(), materialVersion: revision, keyVersion: revision,
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime().nullable(), refreshAfter: z.string().datetime().nullable(),
  authorityExpiresAt: z.string().datetime().nullable(),
}).strict();
export type CloudAgentBootVaultBinding = z.infer<typeof bindingSchema>;

function rejected(): never { throw new HttpError(403, "cloud_validation_access_denied", "cloud_validation_access_denied"); }
function binding(value: unknown): CloudAgentBootVaultBinding {
  const parsed = bindingSchema.safeParse(value);
  if (!parsed.success || !parsed.data.kind.startsWith(`${parsed.data.provider}-`)) rejected();
  return parsed.data;
}
function aad(value: CloudAgentBootVaultBinding): Buffer {
  return Buffer.from(JSON.stringify([
    purpose, value.organizationId.toLowerCase(), value.workspaceId.toLowerCase(), value.generation,
    value.engineInstanceId.toLowerCase(), value.bootId.toLowerCase(), value.writerEpoch.toLowerCase(),
    value.fundingOwnerUserId.toLowerCase(), value.fundingOwnerEpoch, value.fundingScope, value.cacheRevision,
    value.provider, value.kind, value.credentialId.toLowerCase(), value.credentialRevision, value.connectionRevision,
    value.adoptionId.toLowerCase(), value.materialVersion, value.keyVersion, value.policyDigest,
    value.expiresAt, value.refreshAfter, value.authorityExpiresAt,
  ]));
}
function derive(encoded: string): Buffer {
  const root = Buffer.from(encoded, "base64url");
  try {
    if (root.length !== 32 || root.toString("base64url") !== encoded) rejected();
    return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), purpose, 32));
  } finally { root.fill(0); }
}
function positive(value: unknown, admitted: CloudAgentBootVaultBinding): CloudAgentAccessMaterial {
  const parsed = CloudAgentAccessMaterialSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind !== admitted.kind) rejected();
  if (parsed.data.kind === "codex-chatgpt" && (!admitted.expiresAt || !admitted.refreshAfter ||
    parsed.data.expiresAt * 1000 !== Date.parse(admitted.expiresAt) || Date.parse(admitted.refreshAfter) > Date.parse(admitted.expiresAt))) rejected();
  if (parsed.data.kind !== "codex-chatgpt" && admitted.refreshAfter !== null) rejected();
  return parsed.data;
}

/** The parent credential schema is only an input validator. Construct the
 * smaller allowed delivery projection; never return its native cache/refresh. */
export function projectCloudAgentBootAccess(value: unknown): CloudAgentAccessMaterial {
  const parsed = CloudAgentCredentialMaterialSchema.safeParse(value);
  if (!parsed.success) rejected();
  const material = parsed.data;
  switch (material.kind) {
    case "claude-api-key": case "codex-api-key": case "cursor-api-key":
      return CloudAgentAccessMaterialSchema.parse({ kind: material.kind, apiKey: material.apiKey });
    case "claude-setup-token":
      return CloudAgentAccessMaterialSchema.parse({ kind: material.kind, accessToken: material.accessToken });
    case "codex-chatgpt":
      return CloudAgentAccessMaterialSchema.parse({ kind: material.kind, accessToken: material.accessToken,
        accountId: material.accountId, expiresAt: material.expiresAt });
  }
}

export function sealCloudAgentBootAccess(value: unknown, suppliedBinding: unknown, encodedKey: string): CloudAgentCredentialEnvelope {
  let key: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    const admitted = binding(suppliedBinding), material = positive(value, admitted);
    key = derive(encodedKey); plaintext = Buffer.from(JSON.stringify(material));
    return sealCredentialBytes(plaintext, aad(admitted), key);
  } catch { return rejected(); }
  finally { key?.fill(0); plaintext?.fill(0); }
}

export function openCloudAgentBootAccess(envelope: CloudAgentCredentialEnvelope, suppliedBinding: unknown,
  keys: CloudAgentCredentialKeys["keys"]): CloudAgentAccessMaterial {
  let key: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    const admitted = binding(suppliedBinding), encoded = keys[admitted.keyVersion];
    if (!encoded || !envelope || !Buffer.isBuffer(envelope.nonce) || !Buffer.isBuffer(envelope.authTag) ||
      !Buffer.isBuffer(envelope.ciphertext) || envelope.nonce.length !== 12 || envelope.authTag.length !== 16 ||
      envelope.ciphertext.length < 1 || envelope.ciphertext.length > 36_864) rejected();
    key = derive(encoded); plaintext = openCredentialBytes(envelope, aad(admitted), key);
    return positive(JSON.parse(plaintext.toString("utf8")), admitted);
  } catch { return rejected(); }
  finally { key?.fill(0); plaintext?.fill(0); }
}
const adoptionPurpose = "zeros-cloud-agent-adoption-key-v1";
const adoptionBindingSchema = CloudAgentBootScopeSchema.pick({
  organizationId: true, workspaceId: true, fundingOwnerUserId: true,
}).extend({ provider: z.enum(["claude", "codex", "cursor"]),
  kind: z.enum(["claude-api-key", "claude-setup-token", "codex-api-key", "codex-chatgpt", "cursor-api-key"]),
  keyId: z.string().uuid(), keyVersion: z.number().int().positive().safe(),
}).strict();
export type CloudAgentAdoptionKeyBinding = z.infer<typeof adoptionBindingSchema>;
function adoptionBinding(value: unknown): CloudAgentAdoptionKeyBinding {
  const parsed = adoptionBindingSchema.safeParse(value);
  if (!parsed.success || !parsed.data.kind.startsWith(`${parsed.data.provider}-`)) rejected();
  return parsed.data;
}
function adoptionScope(value: CloudAgentAdoptionKeyBinding): readonly string[] {
  return [value.organizationId.toLowerCase(), value.workspaceId.toLowerCase(),
    value.provider, value.kind, value.fundingOwnerUserId.toLowerCase(), value.keyId.toLowerCase()];
}
function adoptionAad(value: CloudAgentAdoptionKeyBinding): Buffer {
  return Buffer.from(JSON.stringify([adoptionPurpose, ...adoptionScope(value), value.keyVersion]));
}
function adoptionWrappingKey(encoded: string): Buffer {
  const root = Buffer.from(encoded, "base64url");
  try {
    if (root.length !== 32 || root.toString("base64url") !== encoded) rejected();
    return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), adoptionPurpose, 32));
  } finally { root.fill(0); }
}
/** The scoped fingerprint key is CP-only and different from provider access.
 * Root rotation rewraps these bytes; it never remints account presentation. */
export function sealCloudAgentAdoptionKey(value: Buffer, supplied: unknown, root: string): CloudAgentCredentialEnvelope {
  let key: Buffer | undefined;
  try {
    const admitted = adoptionBinding(supplied);
    if (!Buffer.isBuffer(value) || value.length !== 32) rejected();
    key = adoptionWrappingKey(root);
    return sealCredentialBytes(value, adoptionAad(admitted), key);
  } catch { return rejected(); }
  finally { key?.fill(0); }
}
export function openCloudAgentAdoptionKey(envelope: CloudAgentCredentialEnvelope, supplied: unknown,
  keys: CloudAgentCredentialKeys["keys"]): Buffer {
  let key: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    const admitted = adoptionBinding(supplied), encoded = keys[admitted.keyVersion];
    if (!encoded || !envelope || !Buffer.isBuffer(envelope.nonce) || !Buffer.isBuffer(envelope.authTag) ||
      !Buffer.isBuffer(envelope.ciphertext) || envelope.nonce.length !== 12 || envelope.authTag.length !== 16 ||
      envelope.ciphertext.length !== 32) rejected();
    key = adoptionWrappingKey(encoded); plaintext = openCredentialBytes(envelope, adoptionAad(admitted), key);
    if (plaintext.length !== 32) rejected();
    return Buffer.from(plaintext);
  } catch { return rejected(); }
  finally { key?.fill(0); plaintext?.fill(0); }
}
/** Store only the fingerprint and opaque UUID in CP. Token/expiry/model/label
 * and wrapping-root updates are not an account/key adoption. */
export function fingerprintCloudAgentAdoption(value: unknown, supplied: unknown, key: Buffer): Buffer {
  try {
    const admitted = adoptionBinding(supplied), parsed = CloudAgentAccessMaterialSchema.safeParse(value);
    if (!Buffer.isBuffer(key) || key.length !== 32 || !parsed.success || parsed.data.kind !== admitted.kind) rejected();
    const material = parsed.data;
    const source = material.kind === "codex-chatgpt" ? ["account", material.accountId] :
      material.kind === "claude-setup-token" ? ["setup-key", material.accessToken] : ["api-key", material.apiKey];
    return createHmac("sha256", key).update(JSON.stringify([
      "zeros-cloud-agent-adoption-fingerprint-v1", ...adoptionScope(admitted), ...source,
    ])).digest();
  } catch { return rejected(); }
}

type AdoptionKeyRow = {
  id: string; org_id: string; workspace_id: string; funding_owner_user_id: string;
  provider: string; kind: string; key_version: string; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer;
};
function adoptionRowBinding(row: AdoptionKeyRow): CloudAgentAdoptionKeyBinding {
  return adoptionBinding({ organizationId: row.org_id, workspaceId: row.workspace_id,
    fundingOwnerUserId: row.funding_owner_user_id, provider: row.provider, kind: row.kind,
    keyId: row.id, keyVersion: readRevision(row.key_version) });
}
function adoptionEnvelope(row: AdoptionKeyRow): CloudAgentCredentialEnvelope {
  return { nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag };
}
function configuredAdoptionRoot(keys: CloudAgentCredentialKeys): string {
  if (!keys || !revision.safeParse(keys.currentKeyVersion).success) rejected();
  const encoded = keys.keys?.[keys.currentKeyVersion];
  if (!encoded) rejected();
  // Validate before changing any persistent policy; this derived byte buffer
  // is disposable and does not leave the CP.
  const verified = adoptionWrappingKey(encoded); verified.fill(0);
  return encoded;
}
async function lockAdoptionKeyPolicy(tx: Tx, keys: CloudAgentCredentialKeys, lock: "share" | "update"): Promise<number> {
  configuredAdoptionRoot(keys);
  await tx.query(`INSERT INTO cloud_agent_adoption_key_policy(id,current_key_version)
    VALUES(1,$1) ON CONFLICT(id) DO NOTHING`, [keys.currentKeyVersion]);
  const result = await tx.query<{ current_key_version: string }>(
    `SELECT current_key_version FROM cloud_agent_adoption_key_policy WHERE id=1 FOR ${lock === "share" ? "SHARE" : "UPDATE"}`);
  if (result.rows.length !== 1) rejected();
  return readRevision(result.rows[0]!.current_key_version);
}

/** Private presentation allocation, never funding or actor authorization.
 * Caller authenticates the current engine and positive credential source in
 * this SAME system transaction. The recorded boot is checked independently;
 * the random scoped key excludes boot, label, policy and access-token epochs. */
export async function allocateCloudAgentAdoptionId(tx: Tx, supplied: CloudAgentBootScope,
  value: unknown, keys: CloudAgentCredentialKeys): Promise<string> {
  const parsed = CloudAgentBootScopeSchema.safeParse(supplied), material = CloudAgentAccessMaterialSchema.safeParse(value);
  if (!parsed.success || !material.success) rejected();
  const scope = parsed.data, provider = material.data.kind.split("-", 1)[0]!;
  const owner = await tx.query(`SELECT id FROM users
    WHERE id=$1 AND deleted_at IS NULL AND auth_status='active' FOR SHARE`, [scope.fundingOwnerUserId]);
  if (owner.rowCount !== 1) rejected();
  // Re-read after the conflicting account lock: a waiting statement's earlier
  // snapshot must not miss a purge that committed while it waited.
  if ((await tx.query("SELECT 1 FROM cloud_agent_adoption_retired_owners WHERE user_id=$1", [scope.fundingOwnerUserId])).rowCount !== 0) rejected();
  // Serialize new scopes within the workspace before taking the root policy;
  // rotation never needs the workspace lock, keeping lock order acyclic.
  const workspace = await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE",
    [scope.workspaceId, scope.organizationId]);
  if (workspace.rowCount !== 1) rejected();
  const recorded = await tx.query(`SELECT binding.id FROM cloud_agent_boot_bindings binding
    JOIN cloud_workspace_engine_instances engine ON engine.id=binding.engine_instance_id AND engine.workspace_id=binding.workspace_id
      AND engine.org_id=binding.org_id AND engine.generation=binding.generation AND engine.runtime_boot_id=binding.boot_id
    JOIN cloud_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.org_id=binding.org_id
      AND workspace.current_generation=binding.generation
    JOIN cloud_workspace_local_command_writers writer ON writer.workspace_id=binding.workspace_id AND writer.org_id=binding.org_id
      AND writer.writer_epoch=binding.writer_epoch AND writer.boot_id=binding.boot_id AND writer.engine_instance_id=binding.engine_instance_id
      AND writer.generation=binding.generation AND writer.funding_owner_user_id=binding.funding_owner_user_id
      AND writer.funding_owner_epoch=binding.funding_owner_epoch
    WHERE binding.org_id=$1 AND binding.workspace_id=$2 AND binding.generation=$3 AND binding.engine_instance_id=$4
      AND binding.boot_id=$5 AND binding.writer_epoch=$6 AND binding.funding_owner_user_id=$7 AND binding.funding_owner_epoch=$8
      AND binding.retired_at IS NULL AND writer.state IN ('reserved','active')
      AND engine.state='ready' AND engine.revoked_at IS NULL AND engine.lease_expires_at>clock_timestamp()
    FOR SHARE OF binding,engine,writer`, [scope.organizationId, scope.workspaceId, scope.generation, scope.engineInstanceId,
    scope.bootId, scope.writerEpoch, scope.fundingOwnerUserId, scope.fundingOwnerEpoch]);
  if (recorded.rowCount !== 1) rejected();
  if (await lockAdoptionKeyPolicy(tx, keys, "share") !== keys.currentKeyVersion) rejected();
  const lookup = () => tx.query<AdoptionKeyRow>(`SELECT * FROM cloud_agent_adoption_keys
    WHERE org_id=$1 AND workspace_id=$2 AND funding_owner_user_id=$3 AND provider=$4 AND kind=$5 FOR UPDATE`,
    [scope.organizationId, scope.workspaceId, scope.fundingOwnerUserId, provider, material.data.kind]);
  let row = (await lookup()).rows[0], key: Buffer | undefined, fingerprint: Buffer | undefined;
  try {
    if (!row) {
      const count = (await tx.query<{ count: string }>("SELECT count(*) FROM cloud_agent_adoption_keys WHERE workspace_id=$1", [scope.workspaceId])).rows[0];
      if (!count || Number(count.count) >= 32) throw new HttpError(409, "cloud_validation_execution_limit", "cloud_validation_execution_limit");
      const admitted = adoptionBinding({ organizationId: scope.organizationId, workspaceId: scope.workspaceId,
        fundingOwnerUserId: scope.fundingOwnerUserId, provider, kind: material.data.kind, keyId: randomUUID(), keyVersion: keys.currentKeyVersion });
      key = randomBytes(32);
      const envelope = sealCloudAgentAdoptionKey(key, admitted, configuredAdoptionRoot(keys));
      await tx.query(`INSERT INTO cloud_agent_adoption_keys
        (id,org_id,workspace_id,funding_owner_user_id,provider,kind,key_version,nonce,ciphertext,auth_tag)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [admitted.keyId, admitted.organizationId, admitted.workspaceId,
        admitted.fundingOwnerUserId, admitted.provider, admitted.kind, admitted.keyVersion, envelope.nonce, envelope.ciphertext, envelope.authTag]);
      row = (await lookup()).rows[0];
    }
    if (!row || readRevision(row.key_version) !== keys.currentKeyVersion) rejected();
    const admitted = adoptionRowBinding(row);
    key ??= openCloudAgentAdoptionKey(adoptionEnvelope(row), admitted, keys.keys);
    fingerprint = fingerprintCloudAgentAdoption(material.data, admitted, key);
    const previous = (await tx.query<{ id: string }>("SELECT id FROM cloud_agent_adoptions WHERE key_id=$1 AND fingerprint=$2", [row.id, fingerprint])).rows[0];
    if (previous) return previous.id;
    const count = (await tx.query<{ count: string }>("SELECT count(*) FROM cloud_agent_adoptions WHERE key_id=$1", [row.id])).rows[0];
    if (!count || Number(count.count) >= 256) throw new HttpError(409, "cloud_validation_execution_limit", "cloud_validation_execution_limit");
    const result = await tx.query<{ id: string }>("INSERT INTO cloud_agent_adoptions(key_id,fingerprint) VALUES($1,$2) RETURNING id", [row.id, fingerprint]);
    if (result.rows.length !== 1) rejected();
    return result.rows[0]!.id;
  } finally { key?.fill(0); fingerprint?.fill(0); }
}

/** Called only by the account-erasure transaction. The account row outlives
 * anonymization; its irreversible nonsecret fence owns private key cleanup. */
export async function purgeCloudAgentAdoptions(tx: Tx, userId: string): Promise<void> {
  if (!z.string().uuid().safeParse(userId).success) rejected();
  if ((await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId])).rowCount !== 1) rejected();
  await tx.query("INSERT INTO cloud_agent_adoption_retired_owners(user_id) VALUES($1) ON CONFLICT DO NOTHING", [userId]);
  await tx.query("DELETE FROM cloud_agent_adoption_keys WHERE funding_owner_user_id=$1", [userId]);
}

/** Background CP maintenance only. Hold the policy writer lock through every
 * bounded batch, verified rewrap and commit. An old configured writer cannot
 * recreate an old-root-only envelope after this transaction commits. No
 * provider material is needed, including previously used unavailable A. */
export async function rewrapCloudAgentAdoptionKeys(tx: Tx, keys: CloudAgentCredentialKeys): Promise<number> {
  const previous = await lockAdoptionKeyPolicy(tx, keys, "update"), root = configuredAdoptionRoot(keys);
  if (keys.currentKeyVersion < previous) rejected();
  await tx.query("UPDATE cloud_agent_adoption_key_policy SET current_key_version=$1 WHERE id=1", [keys.currentKeyVersion]);
  let count = 0;
  for (;;) {
    const rows = (await tx.query<AdoptionKeyRow>(`SELECT * FROM cloud_agent_adoption_keys
      WHERE key_version<>$1 ORDER BY id LIMIT 256 FOR UPDATE`, [keys.currentKeyVersion])).rows;
    if (!rows.length) return count;
    for (const row of rows) {
      const before = adoptionRowBinding(row);
      if (before.keyVersion > keys.currentKeyVersion) rejected();
      let key: Buffer | undefined, verified: Buffer | undefined;
      try {
        key = openCloudAgentAdoptionKey(adoptionEnvelope(row), before, keys.keys);
        const after = { ...before, keyVersion: keys.currentKeyVersion }, envelope = sealCloudAgentAdoptionKey(key, after, root);
        verified = openCloudAgentAdoptionKey(envelope, after, keys.keys);
        if (!verified.equals(key)) rejected();
        const written = await tx.query(`UPDATE cloud_agent_adoption_keys SET key_version=$2,nonce=$3,ciphertext=$4,auth_tag=$5
          WHERE id=$1 AND key_version=$6`, [row.id, after.keyVersion, envelope.nonce, envelope.ciphertext, envelope.authTag, before.keyVersion]);
        if (written.rowCount !== 1) rejected();
        count++;
      } finally { key?.fill(0); verified?.fill(0); }
    }
  }
}

const readTargetSchema = z.object({ organizationId: z.string().uuid(), workspaceId: z.string().uuid() }).strict();
type ReadBootRow = {
  mode: unknown; pointer: unknown; hasActivatedWriter: unknown; bindingId: unknown; binding: unknown; writer: unknown;
  engineBootId: unknown; writerState: unknown; initialized: unknown; cacheRevision: unknown; desiredCacheRevision: unknown;
  initialAdoptions: unknown; currentFundingOwnerUserId: unknown; currentFundingOwnerEpoch: unknown;
};
export type CurrentCloudAgentBootBinding = z.infer<typeof CloudAgentBootScopeSchema> & {
  id: string; fundingScope: "workspace-roles-v1"; writerState: "active" | "retired";
  cacheRevision: number; desiredCacheRevision: number;
  initialAdoptions: z.infer<typeof CloudAgentInitialAdoptionsSchema>; status: "current" | "owner-changed";
};
export type CurrentCloudAgentBootMode = { mode: "legacy" } | { mode: "boot-owner-v1"; binding: CurrentCloudAgentBootBinding };
function readRevision(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value))) rejected();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) rejected();
  return number;
}
/** Caller authorizes the read actor in the same transaction. This helper is
 * passive: exact persisted pointer, no latest writer, recovery or engine wake.
 * Database-port errors propagate as unavailable; malformed authority refuses. */
export async function readCurrentCloudAgentBootBinding(tx: Tx, supplied: unknown): Promise<CurrentCloudAgentBootMode> {
  const target = readTargetSchema.safeParse(supplied);
  if (!target.success) rejected();
  const row = (await tx.query<ReadBootRow>(`SELECT workspace.agent_command_mode AS mode,
      workspace.agent_boot_id AS pointer,
      EXISTS(SELECT 1 FROM cloud_workspace_local_command_writers candidate
        WHERE candidate.workspace_id=workspace.id AND candidate.org_id=workspace.org_id
          AND candidate.state IN ('active','retired')) AS "hasActivatedWriter",
      binding.id AS "bindingId",
      CASE WHEN binding.id IS NOT NULL THEN jsonb_build_object('organizationId',binding.org_id,
        'workspaceId',binding.workspace_id,'generation',binding.generation,'engineInstanceId',binding.engine_instance_id,
        'bootId',binding.boot_id,'writerEpoch',binding.writer_epoch,'fundingOwnerUserId',binding.funding_owner_user_id,
        'fundingOwnerEpoch',binding.funding_owner_epoch) END AS binding,
      CASE WHEN writer.writer_epoch IS NOT NULL THEN jsonb_build_object('organizationId',writer.org_id,
        'workspaceId',writer.workspace_id,'generation',writer.generation,'engineInstanceId',writer.engine_instance_id,
        'bootId',writer.boot_id,'writerEpoch',writer.writer_epoch,'fundingOwnerUserId',writer.funding_owner_user_id,
        'fundingOwnerEpoch',writer.funding_owner_epoch) END AS writer,
      engine.runtime_boot_id AS "engineBootId", writer.state AS "writerState",
      binding.credentials_initialized AS initialized, binding.cache_revision AS "cacheRevision",
      binding.desired_cache_revision AS "desiredCacheRevision", binding.initial_adoptions AS "initialAdoptions",
      workspace.owner_user_id AS "currentFundingOwnerUserId",workspace.agent_funding_owner_epoch AS "currentFundingOwnerEpoch"
    FROM cloud_workspaces workspace
    LEFT JOIN cloud_agent_boot_bindings binding ON binding.id=workspace.agent_boot_id
      AND binding.workspace_id=workspace.id AND binding.org_id=workspace.org_id
    LEFT JOIN cloud_workspace_local_command_writers writer ON writer.workspace_id=binding.workspace_id
      AND writer.org_id=binding.org_id AND writer.writer_epoch=binding.writer_epoch
    LEFT JOIN cloud_workspace_engine_instances engine ON engine.id=binding.engine_instance_id
      AND engine.workspace_id=binding.workspace_id AND engine.org_id=binding.org_id AND engine.generation=binding.generation
    WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.deleted_at IS NULL`,
  [target.data.workspaceId, target.data.organizationId])).rows[0];
  if (!row) rejected();
  if (row.mode === "legacy") {
    if (row.pointer !== null || row.hasActivatedWriter !== false || row.bindingId !== null) rejected();
    return { mode: "legacy" };
  }
  if (row.mode !== "boot-owner-v1" || row.pointer !== row.bindingId || row.initialized !== true) rejected();
  const id = z.string().uuid().safeParse(row.bindingId), bound = CloudAgentBootScopeSchema.safeParse(row.binding);
  const writer = CloudAgentBootScopeSchema.safeParse(row.writer), initial = CloudAgentInitialAdoptionsSchema.safeParse(row.initialAdoptions);
  const state = z.enum(["active", "retired"]).safeParse(row.writerState);
  const currentOwner = z.string().uuid().safeParse(row.currentFundingOwnerUserId);
  if (!id.success || !bound.success || !writer.success || !initial.success || !state.success || !currentOwner.success ||
    bound.data.organizationId.toLowerCase() !== target.data.organizationId.toLowerCase() ||
    bound.data.workspaceId.toLowerCase() !== target.data.workspaceId.toLowerCase() || row.engineBootId !== bound.data.bootId ||
    Object.entries(bound.data).some(([field, value]) => writer.data[field as keyof typeof writer.data] !== value)) rejected();
  const cacheRevision = readRevision(row.cacheRevision), desiredCacheRevision = readRevision(row.desiredCacheRevision);
  if (desiredCacheRevision < cacheRevision) rejected();
  const currentFundingOwnerEpoch = readRevision(row.currentFundingOwnerEpoch);
  const status = currentOwner.data === bound.data.fundingOwnerUserId && currentFundingOwnerEpoch === bound.data.fundingOwnerEpoch
    ? "current" as const : "owner-changed" as const;
  return { mode: "boot-owner-v1", binding: { id: id.data, ...bound.data, fundingScope: "workspace-roles-v1",
    writerState: state.data, cacheRevision, desiredCacheRevision, initialAdoptions: initial.data, status } };
}


// The authenticated engine selects no account. The CP reserves a genuine
// writer and freezes the actual funding owner before any positive delivery.
import { CloudAgentBootCredentialRequestSchema, CloudAgentBootCredentialResponseSchema, CloudAgentBootIdentitySchema,
  CloudAgentBootSyncRequestSchema, CloudAgentBootActivateRequestSchema, CloudAgentBootActivateResponseSchema,
  CloudAgentBootRefreshRequestSchema, CloudAgentActorConfirmRequestSchema, CloudAgentWarmActorRequestSchema,
  CloudAgentBootRefreshResponseSchema, CloudAgentBootProviderReadySchema, type CloudAgentBootProviderReady, type CloudAgentBootCredentialResponse } from "./agent-boot-contract.js";
import { assertCurrentCloudEngineAuthority, assertCloudEngineAuthorityDeadline } from "./engine-authority.js";
import { reserveLocalCloudCommandWriter, activateLocalCloudCommandWriter } from "./commands.js";
import { readCloudAgentComputeTrust } from "./agent-compute-trust.js";
import { runtimeCredentialQualificationJoin, runtimeNativeCapabilities } from "./runtime-selection.js";
import { cloudRuntimeQualificationMode } from "./runtime-config.js";
import { cloudAgentModels } from "./agent-models.js";
import { recordCloudAgentFundingConsents, readCloudAgentFundingConsent } from "./agent-funding-consent.js";
import { confirmDetachedCloudActor } from "./actor-sessions.js";
import { CloudActorProvenanceSchema, CloudAgentActorConfirmResponseSchema, CloudAgentWarmActorResponseSchema, type CloudActorProvenance } from "./agent-boot-contract.js";
import { admitBootCustomization } from "./mcp-admission.js";
import { customizationHistoryAuthority } from "./mcp-contract.js";
import { resolveCloudComputerExecutionEnvironment } from "./computer-environment.js";
import type { SecretEncryptionConfiguration } from "./settings.js";
import { readGithubGitAuthor } from "../github-git-author.js";
import { serializeCloudAgentCredentialSourceMutation, recordCloudAgentBootCredentialDelivery } from "./agent-credential-mutations.js";
import { DatabaseCodexAuthRenewal, type CodexCredentialVersion } from "./codex-auth-renewal.js";

type BootEngineScope={organizationId:string;workspaceId:string;generation:number;engineInstanceId:string;heartbeatToken:string};
export type CloudAgentBootOperation="bootstrap"|"sync"|"activate"|"refresh"|"actor-confirm"|"warm-context";
type BootRow={id:string;workspace_id:string;org_id:string;generation:number;engine_instance_id:string;boot_id:string;writer_epoch:string;
  funding_owner_user_id:string;funding_owner_epoch:string;cache_revision:string;desired_cache_revision:string;
  credentials_initialized:boolean;initial_adoptions:unknown;retired_at:Date|null};
type BootSource={id:string;kind:CloudAgentCredentialKind;display_name:string;revision:string;current_version:number;
  material_mode:string;key_version:number;nonce:Buffer;ciphertext:Buffer;auth_tag:Buffer;material_expires_at:Date|null;
  connection_revision:string;models:string[];all_models:boolean;native_capabilities:unknown;mcp_qualified:boolean};
function bootMetadataJson(value:unknown):string {
  const normalize=(item:unknown):unknown=>Array.isArray(item)?item.map(normalize):item&&typeof item==="object"?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,normalize(value)])):item;
  return JSON.stringify(normalize(value));
}
const bootProviders=["claude","codex","cursor"] as const;
const bootSchemas={bootstrap:CloudAgentBootCredentialRequestSchema,sync:CloudAgentBootSyncRequestSchema,activate:CloudAgentBootActivateRequestSchema,
  refresh:CloudAgentBootRefreshRequestSchema,"actor-confirm":CloudAgentActorConfirmRequestSchema,"warm-context":CloudAgentWarmActorRequestSchema};
const unavailable=(provider:typeof bootProviders[number],code:"cloud_agent_credential_required"|"cloud_agent_credential_revoked"|"cloud_agent_credential_expired"|"cloud_runtime_upgrade_required"|"cloud_agent_model_not_authorized")=>({provider,status:"unavailable" as const,code});
function bootScope(row:BootRow):CloudAgentBootScope { return CloudAgentBootScopeSchema.parse({organizationId:row.org_id,workspaceId:row.workspace_id,
  generation:row.generation,engineInstanceId:row.engine_instance_id,bootId:row.boot_id,writerEpoch:row.writer_epoch,
  fundingOwnerUserId:row.funding_owner_user_id,fundingOwnerEpoch:readRevision(row.funding_owner_epoch)}); }

/** A source is retired only by the existing positive provider lifecycle or
 * consumed-resident journal. Revocation, lease expiry and a successor engine
 * are capability fences and never substitute for this proof. Caller retains
 * the existing workspace/lifecycle locks through this same transaction. */
export async function retireCloudAgentBootSources(tx:Tx,scope:{organizationId:string;workspaceId:string;generation:number},
  proof:{kind:"provider-lifecycle";intentId:string}|{kind:"resident-consumed";transitionId:string;engineInstanceId:string}):Promise<void>{
  const proofId=proof.kind==="provider-lifecycle"?proof.intentId:proof.transitionId;
  const confirmed=proof.kind==="provider-lifecycle"?
    await tx.query(`SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4
      AND state='succeeded' AND operation IN ('stop','archive','delete')`,[proofId,scope.workspaceId,scope.organizationId,scope.generation]):
    await tx.query(`SELECT 1 FROM cloud_workspace_runtime_handoffs handoff JOIN cloud_workspace_runtime_transitions runtime USING(transition_id)
      JOIN cloud_workspace_generation_transitions transition ON transition.id=runtime.transition_id
      WHERE handoff.transition_id=$1 AND handoff.workspace_id=$2 AND handoff.org_id=$3 AND transition.source_generation=$4
        AND runtime.source_engine_instance_id=$5 AND handoff.phase IN ('consumed','source_retired') AND handoff.consumed_resident IS NOT NULL
        AND handoff.consumed_resident->>'engineId' IS NULL AND handoff.consumed_resident->>'generation' IS NULL
        AND handoff.deadline_at>clock_timestamp()`,[proofId,scope.workspaceId,scope.organizationId,scope.generation,proof.engineInstanceId]);
  if(confirmed.rowCount!==1)rejected();
  const bindings=(await tx.query<BootRow>(`SELECT * FROM cloud_agent_boot_bindings
    WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND ($4::uuid IS NULL OR engine_instance_id=$4) FOR UPDATE`,
    [scope.workspaceId,scope.organizationId,scope.generation,proof.kind==="resident-consumed"?proof.engineInstanceId:null])).rows;
  for(const binding of bindings){
    // The optional committed seal is preserved. Forced/unsealed retirement
    // records only source death; it cannot invent complete replay coverage.
    await tx.query(`UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=clock_timestamp()
      WHERE workspace_id=$1 AND org_id=$2 AND writer_epoch=$3 AND state='active'`,[scope.workspaceId,scope.organizationId,binding.writer_epoch]);
    await tx.query("UPDATE cloud_agent_boot_bindings SET retired_at=coalesce(retired_at,clock_timestamp()) WHERE id=$1",[binding.id]);
    await tx.query("UPDATE cloud_agent_boot_source_deliveries SET retired_proof_id=$2 WHERE binding_id=$1 AND retired_proof_id IS NULL",[binding.id,proofId]);
    await tx.query(`INSERT INTO cloud_agent_credential_source_retirements(control_id,proof_kind,proof_id)
      SELECT id,$2,$3 FROM cloud_agent_credential_controls WHERE binding_id=$1 AND request @> $4::jsonb
      ON CONFLICT(control_id) DO NOTHING`,[binding.id,proof.kind,proofId,JSON.stringify(bootScope(binding))]);
    await tx.query("DELETE FROM cloud_agent_boot_credentials WHERE binding_id=$1",[binding.id]);
    await tx.query("DELETE FROM cloud_agent_boot_contexts WHERE binding_id=$1",[binding.id]);
    await tx.query("DELETE FROM cloud_agent_boot_refreshes WHERE binding_id=$1",[binding.id]);
  }
}

export class DatabaseCloudAgentBootService {
  constructor(private readonly pool:pg.Pool,private readonly keys:CloudAgentCredentialKeys,private readonly workosEnabled:boolean,
    private readonly settingsEncryption:SecretEncryptionConfiguration={},private readonly codexRenewal=new DatabaseCodexAuthRenewal(pool,keys)){}
  async execute(engine:BootEngineScope,operation:CloudAgentBootOperation,value:unknown):Promise<unknown> {
    const request=bootSchemas[operation].safeParse(value);
    if(!request.success)throw new HttpError(422,"invalid_agent_execution","invalid_agent_execution");
    for(const field of ["organizationId","workspaceId","generation","engineInstanceId"] as const)
      if(engine[field]!==request.data[field])rejected();
    if(operation==="refresh")return this.refresh(engine,CloudAgentBootRefreshRequestSchema.parse(request.data));
    return this.withBinding(engine,operation,request.data,async(tx,row,identity)=>{
      const scope=bootScope(row);
      if(operation==="actor-confirm"||operation==="warm-context") {
        const actorRequest=operation==="actor-confirm"?CloudAgentActorConfirmRequestSchema.parse(request.data):CloudAgentWarmActorRequestSchema.parse(request.data);
        const actor=await this.confirmActor(tx,scope,actorRequest.actorSessionId,identity.authorityEpoch);
        if(operation==="actor-confirm") {
          await assertCloudEngineAuthorityDeadline(tx,engine.engineInstanceId,this.workosEnabled);
          return CloudAgentActorConfirmResponseSchema.parse({version:1,mode:"boot-owner-v1",provenance:actor});
        }
        return this.warmContext(tx,engine,row,identity,actor,CloudAgentWarmActorRequestSchema.parse(request.data));
      }
      const response=await this.synchronize(tx,row,identity);
      await assertCloudEngineAuthorityDeadline(tx,engine.engineInstanceId,this.workosEnabled);
      if(operation!=="activate")return response;
      const activation=CloudAgentBootActivateRequestSchema.parse(request.data);
      if(response.cacheRevision!==response.desiredCacheRevision||activation.expectedCacheRevision!==response.cacheRevision)
        throw new HttpError(503,"cloud_agent_credential_busy","cloud_agent_credential_busy");
      // reserve is inert. Only this separate ready-epoch call activates and
      // commits the exact private pointer atomically with W4's writer fence.
      await activateLocalCloudCommandWriter(tx,{...engine,workosEnabled:this.workosEnabled},{bootId:scope.bootId,writerEpoch:scope.writerEpoch});
      await tx.query("UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$3 WHERE id=$1 AND org_id=$2",[scope.workspaceId,scope.organizationId,row.id]);
      return CloudAgentBootActivateResponseSchema.parse({...identity,cacheRevision:response.cacheRevision,activated:true});
    });
  }
  private withBinding<T>(engine:BootEngineScope,operation:CloudAgentBootOperation,request:Record<string,unknown>,
    run:(tx:Tx,row:BootRow,identity:z.infer<typeof CloudAgentBootIdentitySchema>)=>Promise<T>):Promise<T> {
    return withSystemTx(this.pool,async tx=>{
      // Account/owner fence precedes workspace/engine locks, like Settings,
      // retirement and adoption allocation. Re-read after every wait.
      const candidate=(await tx.query<{funding_owner_user_id:string}>(`SELECT coalesce(binding.funding_owner_user_id,workspace.owner_user_id) AS funding_owner_user_id
        FROM cloud_workspaces workspace LEFT JOIN cloud_agent_boot_bindings binding ON binding.engine_instance_id=$3
          AND binding.workspace_id=workspace.id AND binding.org_id=workspace.org_id
        WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.deleted_at IS NULL`,[engine.workspaceId,engine.organizationId,engine.engineInstanceId])).rows[0];
      if(!candidate)rejected();
      await serializeCloudAgentCredentialSourceMutation(tx,candidate.funding_owner_user_id);
      const authority=await assertCurrentCloudEngineAuthority(tx,{...engine,workosEnabled:this.workosEnabled});
      const registered=(await tx.query<{runtime_boot_id:string;cloud_local_commands_version:number|null}>("SELECT runtime_boot_id,cloud_local_commands_version FROM cloud_workspace_engine_instances WHERE id=$1",[engine.engineInstanceId])).rows[0];
      if(registered?.cloud_local_commands_version!==1)throw new HttpError(409,"cloud_runtime_upgrade_required","cloud_runtime_upgrade_required");
      let row=(await tx.query<BootRow>("SELECT * FROM cloud_agent_boot_bindings WHERE engine_instance_id=$1 FOR UPDATE",[engine.engineInstanceId])).rows[0];
      if(!row) {
        if(operation!=="bootstrap")rejected();
        const workspace=(await tx.query<{owner_user_id:string;agent_funding_owner_epoch:string}>("SELECT owner_user_id,agent_funding_owner_epoch FROM cloud_workspaces WHERE id=$1 AND org_id=$2",[engine.workspaceId,engine.organizationId])).rows[0];
        if(!workspace||workspace.owner_user_id!==candidate.funding_owner_user_id)rejected();
        const writerEpoch=await reserveLocalCloudCommandWriter(tx,{...engine,workosEnabled:this.workosEnabled},registered.runtime_boot_id,workspace.owner_user_id,readRevision(workspace.agent_funding_owner_epoch));
        row=(await tx.query<BootRow>(`INSERT INTO cloud_agent_boot_bindings(workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[engine.workspaceId,engine.organizationId,engine.generation,engine.engineInstanceId,registered.runtime_boot_id,writerEpoch,workspace.owner_user_id,workspace.agent_funding_owner_epoch])).rows[0]!;
      }
      const scope=bootScope(row);
      if(!row.credentials_initialized)await recordCloudAgentFundingConsents(tx,{organizationId:scope.organizationId,workspaceId:scope.workspaceId,issuerUserId:scope.fundingOwnerUserId});
      if(row.retired_at||row.boot_id!==registered.runtime_boot_id||scope.organizationId!==engine.organizationId||scope.workspaceId!==engine.workspaceId||scope.generation!==engine.generation)rejected();
      if("bootId" in request && (!z.string().uuid().safeParse(request.bootId).success||request.bootId!==scope.bootId||!("writerEpoch" in request)||request.writerEpoch!==scope.writerEpoch))rejected();
      if("expectedCacheRevision" in request && (typeof request.expectedCacheRevision!=="number"||request.expectedCacheRevision>readRevision(row.desired_cache_revision)))rejected();
      const identity=CloudAgentBootIdentitySchema.parse({...scope,version:1,mode:"boot-owner-v1",fundingScope:"workspace-roles-v1",authorityEpoch:authority.authorityEpoch});
      return run(tx,row,identity);
    });
  }
  private async refresh(engine:BootEngineScope,request:z.infer<typeof CloudAgentBootRefreshRequestSchema>) {
    for(let attempt=0;attempt<2;attempt++) {
      const step=await this.withBinding(engine,"refresh",request,async(tx,row,identity)=>{
        if(readRevision(row.cache_revision)!==readRevision(row.desired_cache_revision))
          throw new HttpError(503,"cloud_agent_credential_busy","cloud_agent_credential_busy");
        const stored=(await tx.query<{metadata:unknown}>("SELECT metadata FROM cloud_agent_boot_credentials WHERE binding_id=$1 AND provider='codex'",[row.id])).rows[0];
        const parsed=CloudAgentBootProviderReadySchema.innerType().omit({material:true}).safeParse(stored?.metadata&&typeof stored.metadata==="object"?
          (({vaultBinding:_binding,...metadata})=>metadata)(stored.metadata as Record<string,unknown>):null);
        if(!parsed.success||parsed.data.kind!=="codex-chatgpt"||parsed.data.credentialId!==request.credentialId||parsed.data.credentialRevision!==request.credentialRevision)rejected();
        const selected=(await tx.query<{revision:string;credential_id:string;credential_revision:string}>(`SELECT revision,credential_id,credential_revision
          FROM cloud_agent_organization_connections WHERE org_id=$1 AND owner_user_id=$2 AND provider='codex' FOR SHARE`,[row.org_id,row.funding_owner_user_id])).rows[0];
        if(!selected||selected.credential_id!==request.credentialId||Number(selected.credential_revision)!==request.credentialRevision)rejected();
        let captured=(await tx.query<{connection_revision:string;adoption_id:string}>(`SELECT connection_revision,adoption_id FROM cloud_agent_boot_refreshes
          WHERE binding_id=$1 AND credential_id=$2 AND credential_revision=$3 AND expected_cache_revision=$4 AND expected_material_version=$5`,
          [row.id,request.credentialId,request.credentialRevision,request.expectedCacheRevision,request.expectedMaterialVersion])).rows[0];
        if(!captured) {
          if(readRevision(row.cache_revision)!==request.expectedCacheRevision||parsed.data.materialVersion!==request.expectedMaterialVersion||
              parsed.data.connectionRevision!==Number(selected.revision)||!parsed.data.refreshAfter||Date.parse(parsed.data.refreshAfter)>Date.now())rejected();
          const count=(await tx.query<{count:number}>("SELECT count(*)::int AS count FROM cloud_agent_boot_refreshes WHERE binding_id=$1",[row.id])).rows[0]!.count;
          if(count>=4096)throw new HttpError(429,"cloud_validation_execution_limit","cloud_validation_execution_limit");
          captured=(await tx.query<{connection_revision:string;adoption_id:string}>(`INSERT INTO cloud_agent_boot_refreshes(binding_id,credential_id,credential_revision,
            expected_cache_revision,expected_material_version,connection_revision,adoption_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING connection_revision,adoption_id`,
            [row.id,request.credentialId,request.credentialRevision,request.expectedCacheRevision,request.expectedMaterialVersion,selected.revision,parsed.data.adoptionId])).rows[0]!;
        }
        if(captured.connection_revision!==selected.revision||captured.adoption_id!==parsed.data.adoptionId)rejected();
        const credential=(await tx.query<CodexCredentialVersion>(`SELECT id,owner_user_id,revision,current_version FROM cloud_agent_credentials
          WHERE id=$1 AND owner_user_id=$2 AND kind='codex-chatgpt' AND revoked_at IS NULL FOR UPDATE`,[request.credentialId,row.funding_owner_user_id])).rows[0];
        if(!credential||Number(credential.revision)!==request.credentialRevision||credential.current_version<request.expectedMaterialVersion)rejected();
        if(credential.current_version===request.expectedMaterialVersion) {
          const reservation=await this.codexRenewal.reserve(tx,credential);
          if(!reservation)throw new HttpError(409,"cloud_validation_credential_refresh_unchanged","cloud_validation_credential_refresh_unchanged");
          await assertCloudEngineAuthorityDeadline(tx,engine.engineInstanceId,this.workosEnabled);
          return {kind:"renewal" as const,reservation};
        }
        const response=await this.synchronize(tx,row,identity),provider=response.providers.find(value=>value.provider==="codex");
        if(!provider||provider.status!=="ready"||provider.kind!=="codex-chatgpt"||provider.credentialId!==request.credentialId||
            provider.credentialRevision!==request.credentialRevision||provider.connectionRevision!==Number(captured.connection_revision)||
            provider.adoptionId!==captured.adoption_id||provider.materialVersion<=request.expectedMaterialVersion||response.cacheRevision<=request.expectedCacheRevision)rejected();
        await assertCloudEngineAuthorityDeadline(tx,engine.engineInstanceId,this.workosEnabled);
        return {kind:"ready" as const,response:CloudAgentBootRefreshResponseSchema.parse({...identity,cacheRevision:response.cacheRevision,
          desiredCacheRevision:response.desiredCacheRevision,provider})};
      });
      if(step.kind==="ready")return step.response;
      // No boot/account lock is held across native OAuth. The existing global
      // fence publishes its known result even if this boot retires meanwhile.
      await this.codexRenewal.complete(step.reservation);
    }
    throw new HttpError(409,"cloud_validation_credential_refresh_unchanged","cloud_validation_credential_refresh_unchanged");
  }
  private async confirmActor(tx:Tx,scope:CloudAgentBootScope,actorSessionId:string,authorityEpoch:number):Promise<CloudActorProvenance> {
    const recorded=await confirmDetachedCloudActor(tx,scope,actorSessionId);
    // Non-owner run consent uses the real funding ledger below; never infer
    // shared funding from a renderer role or borrow the funding owner's actor.
    const fundingGrant=await readCloudAgentFundingConsent(tx,scope,{userId:recorded.actorUserId,role:recorded.role});
    return CloudActorProvenanceSchema.parse({scope,actor:{userId:recorded.actorUserId,deviceId:recorded.deviceId,deviceKeyVersion:recorded.deviceKeyVersion,
      fingerprint:recorded.fingerprint,role:recorded.role},actorSessionId,authorityEpoch,confirmedUntilMs:recorded.confirmedUntilMs,
      fundingConsentVersion:fundingGrant?1:null,fundingGrant});
  }
  private async warmContext(tx:Tx,engine:BootEngineScope,row:BootRow,identity:z.infer<typeof CloudAgentBootIdentitySchema>,actor:CloudActorProvenance,
    request:z.infer<typeof CloudAgentWarmActorRequestSchema>) {
    if(actor.actor.role==="viewer"||!actor.fundingGrant||actor.fundingConsentVersion!==1)rejected();
    const ready=await this.synchronize(tx,row,identity),provider=ready.providers.find(value=>value.provider===request.provider);
    if(!provider||provider.status!=="ready"||!provider.models.includes(request.model))rejected();
    const values=await resolveCloudComputerExecutionEnvironment(tx,engine,actor.actor.userId,this.settingsEncryption),
      history=customizationHistoryAuthority(engine.organizationId,engine.workspaceId,actor.actor.userId,this.keys),
      key=Buffer.from(this.keys.keys[this.keys.currentKeyVersion]!,"base64url");
    let environmentRevision:string;
    try {environmentRevision=createHmac("sha256",key).update(JSON.stringify(["zeros-computer-environment-v1",engine.workspaceId,engine.generation,actor.actor.userId,values])).digest("hex");}
    finally{key.fill(0);}
    const environment={version:1 as const,revision:environmentRevision,values,history};
    const previous=(await tx.query<{context_id:string;context_revision:string}>(`SELECT context_id,context_revision FROM cloud_agent_boot_contexts WHERE binding_id=$1
      AND actor_session_id=$2 AND provider=$3 AND conversation_id=$4 AND model=$5 AND cwd=$6 AND retired_at IS NULL AND expires_at>clock_timestamp()
      ORDER BY created_at DESC,context_id DESC LIMIT 1 FOR UPDATE`,[row.id,request.actorSessionId,request.provider,request.conversationId,request.model,request.cwd])).rows[0];
    let contextId=previous?.context_id??randomUUID();
    const capture=async()=>admitBootCustomization(tx,{...bootScope(row),contextId,actorSessionId:request.actorSessionId,actorUserId:actor.actor.userId,
      actorDeviceId:actor.actor.deviceId,actorDeviceKeyVersion:actor.actor.deviceKeyVersion,actorFingerprint:actor.actor.fingerprint,
      authorityEpoch:identity.authorityEpoch,fundingGrant:actor.fundingGrant!,provider:request.provider,conversationId:request.conversationId,
      model:request.model,cwd:request.cwd},request.repositoryServers,this.keys);
    let customization=await capture();
    const gitAuthor=await readGithubGitAuthor(tx,actor.actor.userId);
    const revisionRoot=Buffer.from(this.keys.keys[this.keys.currentKeyVersion]!,"base64url");
    const revisionKey=Buffer.from(hkdfSync("sha256",revisionRoot,Buffer.alloc(0),"zeros-cloud-agent-context-revision-v1",32));
    let contextRevision:string;
    try {contextRevision=createHmac("sha256",revisionKey).update(bootMetadataJson([bootScope(row),actor.actor,actor.fundingGrant,
      customization.organizationRevision,customization.memberRevision,request.repositoryServers,environment.revision,gitAuthor,
      provider.credentialId,provider.credentialRevision,provider.connectionRevision,provider.models,provider.nativeCapabilities])).digest("hex");}
    finally{revisionRoot.fill(0);revisionKey.fill(0);}
    const previousLive=async()=>previous&&(await tx.query("SELECT 1 FROM cloud_agent_boot_contexts WHERE context_id=$1 AND retired_at IS NULL AND expires_at>clock_timestamp()",[previous.context_id])).rowCount===1;
    if(previous&&(previous.context_revision!==contextRevision||!await previousLive())){
      await tx.query("UPDATE cloud_agent_boot_contexts SET retired_at=clock_timestamp() WHERE context_id=$1",[previous.context_id]);
      contextId=randomUUID();customization=await capture();
    }
    if(contextId!==previous?.context_id){
      const count=(await tx.query<{count:number}>("SELECT count(*)::int AS count FROM cloud_agent_boot_contexts WHERE binding_id=$1",[row.id])).rows[0]!.count;
      if(count>=4096)throw new HttpError(429,"cloud_validation_execution_limit","cloud_validation_execution_limit");
    }
    const current=await this.confirmActor(tx,bootScope(row),request.actorSessionId,identity.authorityEpoch);
    if(bootMetadataJson([current.actor,current.fundingGrant])!==bootMetadataJson([actor.actor,actor.fundingGrant])||current.confirmedUntilMs<=Date.now())rejected();
    await assertCloudEngineAuthorityDeadline(tx,engine.engineInstanceId,this.workosEnabled);
    const published=await tx.query(`INSERT INTO cloud_agent_boot_contexts(context_id,binding_id,actor_session_id,provider,conversation_id,model,cwd,context_revision,binding,
      organization_revision,member_revision,repository_digest,digest,key_version,nonce,ciphertext,auth_tag,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18 WHERE $18::timestamptz>clock_timestamp()
      ON CONFLICT(context_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,
      nonce=EXCLUDED.nonce,ciphertext=EXCLUDED.ciphertext,auth_tag=EXCLUDED.auth_tag,key_version=EXCLUDED.key_version
      WHERE cloud_agent_boot_contexts.retired_at IS NULL AND cloud_agent_boot_contexts.expires_at>clock_timestamp() RETURNING context_id`,
      [contextId,row.id,request.actorSessionId,request.provider,request.conversationId,request.model,request.cwd,contextRevision,customization.binding,
        customization.organizationRevision,customization.memberRevision,customization.repositoryDigest,customization.digest,customization.keyVersion,
        customization.envelope.nonce,customization.envelope.ciphertext,customization.envelope.authTag,new Date(current.confirmedUntilMs)]);
    if(published.rowCount!==1)rejected();
    return CloudAgentWarmActorResponseSchema.parse({...identity,contextId,contextRevision,actor:current,provider:request.provider,conversationId:request.conversationId,
      model:request.model,cwd:request.cwd,gitAuthor,customization:customization.snapshot,
      environment,nativeCapabilities:provider.nativeCapabilities,backgroundTasksVersion:1});
  }
  private async synchronize(tx:Tx,row:BootRow,identity:z.infer<typeof CloudAgentBootIdentitySchema>):Promise<CloudAgentBootCredentialResponse> {
    const scope=bootScope(row),compute=await readCloudAgentComputeTrust(tx,scope.workspaceId);
    // This negotiated path currently admits only zeros-managed compute.
    // Legacy exact explicit delegation remains in the legacy service.
    if(!compute)rejected();
    const consent=(await tx.query<{fingerprint:string}>(`SELECT encode(digest(jsonb_build_array(organization.id,organization.authorization_revision,
      account.id,account.auth_revision,member.authorization_revision,member.role,member.created_at)::text,'sha256'),'hex') AS fingerprint
      FROM organization_members member JOIN organizations organization ON organization.id=member.org_id JOIN users account ON account.id=member.user_id
      WHERE member.org_id=$1 AND member.user_id=$2 AND organization.deleted_at IS NULL AND NOT organization.is_personal
      FOR SHARE OF organization,member`,[scope.organizationId,scope.fundingOwnerUserId])).rows[0];
    if(!consent)rejected();
    // A self-only connection does not establish workspace-role funding on
    // administrator-controlled compute. Keep this negotiated mode closed
    // until exact per-source/model/deadline consent is implemented.
    if(compute.trust!=="zeros-managed")rejected();
    const prior=(await tx.query<{provider:string;metadata:unknown;key_version:number|null;nonce:Buffer|null;ciphertext:Buffer|null;auth_tag:Buffer|null}>("SELECT * FROM cloud_agent_boot_credentials WHERE binding_id=$1",[row.id])).rows;
    const next:CloudAgentBootCredentialResponse["providers"]=[],sealed:Array<{provider:string;metadata:unknown;envelope:CloudAgentCredentialEnvelope|null}>=[];
    let revisionNumber=readRevision(row.desired_cache_revision),changed=false;
    for(const provider of bootProviders) {
      const selected=(await tx.query<{credential_id:string|null;credential_revision:string|null;revision:string;consent_fingerprint:string}>(`SELECT credential_id,credential_revision,revision,consent_fingerprint
        FROM cloud_agent_organization_connections WHERE org_id=$1 AND owner_user_id=$2 AND provider=$3 FOR SHARE`,[scope.organizationId,scope.fundingOwnerUserId,provider])).rows[0];
      let slot:CloudAgentBootCredentialResponse["providers"][number]=unavailable(provider,"cloud_agent_credential_required");
      let material:CloudAgentAccessMaterial|undefined,source:BootSource|undefined;
      if(selected?.credential_id) {
        const parent=(await tx.query<{revoked_at:Date|null;revision:string}>("SELECT revoked_at,revision FROM cloud_agent_credentials WHERE id=$1 AND owner_user_id=$2 FOR SHARE",[selected.credential_id,scope.fundingOwnerUserId])).rows[0];
        if(!parent||parent.revoked_at||!selected.credential_revision||selected.credential_revision!==parent.revision||selected.consent_fingerprint!==consent.fingerprint)
          slot=unavailable(provider,"cloud_agent_credential_revoked");
        else {
          source=(await tx.query<BootSource>(`SELECT credential.id,credential.kind,credential.display_name,credential.revision,credential.current_version,material.material_mode,
            material.key_version,material.nonce,material.ciphertext,material.auth_tag,material.material_expires_at,
            connection.revision AS connection_revision,connection.models,connection.all_models,qualification.native_capabilities,qualification.mcp_qualified
            FROM cloud_agent_credentials credential JOIN cloud_agent_credential_versions material ON material.credential_id=credential.id AND material.version=credential.current_version
            JOIN cloud_agent_credential_organizations association ON association.credential_id=credential.id AND association.owner_user_id=credential.owner_user_id AND association.org_id=$1
            JOIN cloud_agent_organization_connections connection ON connection.credential_id=credential.id AND connection.owner_user_id=credential.owner_user_id AND connection.org_id=$1 AND connection.provider=$4
            JOIN cloud_workspace_engine_instances engine ON engine.id=$3 JOIN cloud_workspace_generations generation ON generation.workspace_id=engine.workspace_id AND generation.generation=engine.generation
            ${runtimeCredentialQualificationJoin("$5","false")}
            WHERE credential.id=$2 AND credential.owner_user_id=$6 AND credential.revoked_at IS NULL FOR SHARE OF credential,material,connection`,
            [scope.organizationId,selected.credential_id,scope.engineInstanceId,provider,cloudRuntimeQualificationMode(),scope.fundingOwnerUserId])).rows[0];
          if(!source||source.material_mode!=="local"||!source.kind.startsWith(`${provider}-`))slot=unavailable(provider,"cloud_runtime_upgrade_required");
          else if(source.material_expires_at&&source.material_expires_at.getTime()<=Date.now()+30_000)slot=unavailable(provider,"cloud_agent_credential_expired");
          else {
            const caps=runtimeNativeCapabilities(source.native_capabilities),models=source.all_models?[...cloudAgentModels(provider)]:source.models.filter(model=>cloudAgentModels(provider).includes(model));
            if(!caps||!models.length)slot=unavailable(provider,"cloud_agent_model_not_authorized");
            else {
              material=projectCloudAgentBootAccess(openCloudAgentCredential({nonce:source.nonce,ciphertext:source.ciphertext,authTag:source.auth_tag},
                {credentialId:source.id,ownerUserId:scope.fundingOwnerUserId,version:source.current_version,keyVersion:source.key_version,kind:source.kind},this.keys.keys));
              const expiresAt=source.material_expires_at?.toISOString()??null;
              const adoptionId=await allocateCloudAgentAdoptionId(tx,scope,material,this.keys);
              slot=CloudAgentBootProviderReadySchema.parse({status:"ready",provider,credentialId:source.id,credentialRevision:readRevision(source.revision),
                connectionRevision:readRevision(source.connection_revision),adoptionId,displayName:source.display_name,kind:source.kind,models,nativeCapabilities:caps,
                materialVersion:source.current_version,expiresAt,refreshAfter:material.kind==="codex-chatgpt"?new Date(material.expiresAt*1000-600_000).toISOString():null,
                authorityExpiresAt:null,material});
            }
          }
        }
      }
      const rawPrevious=prior.find(value=>value.provider===provider)?.metadata;
      const previous=rawPrevious&&typeof rawPrevious==="object"?(({vaultBinding:_binding,...metadata})=>metadata)(rawPrevious as Record<string,unknown>):rawPrevious;
      const metadata=slot.status==="ready"?(({material:_material,...value})=>value)(slot):slot;
      if(row.credentials_initialized && bootMetadataJson(previous)!==bootMetadataJson(metadata)) {
        const previousReady=previous&&typeof previous==="object"?previous as Record<string,unknown>:undefined;
        if(slot.status==="ready"&&readRevision(row.cache_revision)===readRevision(row.desired_cache_revision) &&
          (!previousReady || previousReady.status!=="ready" || previousReady.credentialId!==slot.credentialId ||
            previousReady.credentialRevision!==slot.credentialRevision || previousReady.connectionRevision!==slot.connectionRevision ||
            bootMetadataJson(previousReady.models)!==bootMetadataJson(slot.models) || bootMetadataJson(previousReady.nativeCapabilities)!==bootMetadataJson(slot.nativeCapabilities)))
          throw new HttpError(409,"cloud_runtime_upgrade_required","cloud_runtime_upgrade_required");
        changed=true;
      }
      next.push(slot);sealed.push({provider,metadata,envelope:null});
    }
    if(row.credentials_initialized && revisionNumber===readRevision(row.cache_revision)&&changed)revisionNumber++;
    if(!Number.isSafeInteger(revisionNumber))rejected();
    await tx.query("UPDATE cloud_agent_boot_bindings SET desired_cache_revision=$2 WHERE id=$1",[row.id,revisionNumber]);
    for(let i=0;i<next.length;i++) {
      const slot=next[i]!,store=sealed[i]!;
      if(slot.status==="ready") {
        const policyDigest=createHash("sha256").update(JSON.stringify([store.metadata,compute])).digest("hex");
        const vaultBinding:CloudAgentBootVaultBinding={...scope,fundingScope:"workspace-roles-v1",cacheRevision:revisionNumber,provider:slot.provider,kind:slot.kind,
          credentialId:slot.credentialId,credentialRevision:slot.credentialRevision,connectionRevision:slot.connectionRevision,adoptionId:slot.adoptionId,
          materialVersion:slot.materialVersion,keyVersion:this.keys.currentKeyVersion,policyDigest,expiresAt:slot.expiresAt,refreshAfter:slot.refreshAfter,authorityExpiresAt:slot.authorityExpiresAt};
        store.envelope=sealCloudAgentBootAccess(slot.material,vaultBinding,this.keys.keys[this.keys.currentKeyVersion]!);
        await recordCloudAgentBootCredentialDelivery(tx,scope,{provider:slot.provider,credentialId:slot.credentialId},{cacheRevision:revisionNumber,connectionRevision:slot.connectionRevision});
        store.metadata={...store.metadata as object,vaultBinding};
      }
    }
    await tx.query("DELETE FROM cloud_agent_boot_credentials WHERE binding_id=$1",[row.id]);
    for(const stored of sealed)await tx.query(`INSERT INTO cloud_agent_boot_credentials(binding_id,provider,metadata,key_version,nonce,ciphertext,auth_tag)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[row.id,stored.provider,stored.metadata,stored.envelope?this.keys.currentKeyVersion:null,stored.envelope?.nonce??null,stored.envelope?.ciphertext??null,stored.envelope?.authTag??null]);
    const baseline=row.credentials_initialized?CloudAgentInitialAdoptionsSchema.parse(row.initial_adoptions):next.map(slot=>slot.status==="ready"?
      {provider:slot.provider,status:"known" as const,adoptionId:slot.adoptionId}:{provider:slot.provider,status:slot.code==="cloud_agent_credential_required"?"missing" as const:"unknown" as const});
    await tx.query(`UPDATE cloud_agent_boot_bindings SET cache_revision=$2,desired_cache_revision=$2,credentials_initialized=true,initial_adoptions=$3 WHERE id=$1`,[row.id,revisionNumber,JSON.stringify(baseline)]);
    return CloudAgentBootCredentialResponseSchema.parse({...identity,cacheRevision:revisionNumber,desiredCacheRevision:revisionNumber,initialAdoptions:baseline,providers:next});
  }
}
