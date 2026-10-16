import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";

import type { Tx } from "../db.js";
import {
  CAPABILITY_CONTRACT_VERSION,
  CAPABILITY_ENGINE_SCOPES,
  CAPABILITY_TOKEN_LIFETIME_SECONDS,
  CAPABILITY_TOKEN_MAX_BYTES,
  CAPABILITY_TOKEN_TYPE,
  CapabilityClaimsSchema,
  type CapabilityAudience,
  type CapabilityClaims,
} from "./capability-contract.js";
import type { CapabilitySigningKeyStore } from "./capability-keys.js";
import { isSupportedCloudWorkspaceProviderBinding } from "./provider.js";

/** Issuance fails closed (S1): if a role or an epoch cannot be read, or no
 * current signing key can be opened, the answer is 503. */
export class CapabilityIssuerUnavailableError extends Error {
  readonly code = "capability_issuer_unavailable";
  constructor() {
    super("Capability issuance is not available");
    this.name = "CapabilityIssuerUnavailableError";
  }
}

/** A policy denial at issuance, mapped to the existing workspace codes. */
export class CapabilityIssuanceError extends Error {
  constructor(readonly code: "workspace_role_required" | "workspace_replica_device_proof_rejected" | "capability_revoked" | "capability_expired" | "cloud_workspace_not_found") {
    super(`Capability issuance refused: ${code}`);
    this.name = "CapabilityIssuanceError";
  }
}

export type IssuedCapability = {
  token: string;
  expiresAt: Date;
  /** 60% of the lifetime: when the push or REST renewal should happen. */
  renewAt: Date;
};

type Role = "viewer" | "prompter" | "developer" | "manager" | "owner";

function newJti(): string {
  return randomBytes(16).toString("base64url");
}

async function sign(store: CapabilitySigningKeyStore, claims: CapabilityClaims): Promise<IssuedCapability> {
  const signer = store.signer();
  if (!signer) throw new CapabilityIssuerUnavailableError();
  const parsed = CapabilityClaimsSchema.safeParse(claims);
  if (!parsed.success) throw new CapabilityIssuerUnavailableError();
  const token = await new SignJWT(parsed.data as Record<string, unknown>)
    .setProtectedHeader({ alg: "EdDSA", typ: CAPABILITY_TOKEN_TYPE, kid: signer.kid })
    .sign(signer.key);
  if (Buffer.byteLength(token, "utf8") > CAPABILITY_TOKEN_MAX_BYTES) throw new CapabilityIssuerUnavailableError();
  return {
    token,
    expiresAt: new Date(claims.exp * 1000),
    renewAt: new Date(claims.iat * 1000 + CAPABILITY_TOKEN_LIFETIME_SECONDS * 600),
  };
}

function baseClaims(
  issuer: string,
  scope: { organizationId: string; workspaceId: string; generation: number },
): Pick<CapabilityClaims, "iss" | "org" | "wsp" | "gen" | "cv" | "jti"> {
  return {
    iss: issuer,
    org: scope.organizationId,
    wsp: scope.workspaceId,
    gen: scope.generation,
    cv: CAPABILITY_CONTRACT_VERSION,
    jti: newJti(),
  };
}

/** The supported-generation predicate the workspace document projects with
 * (routes.ts workspaceSelect). Kept verbatim; scope parity with the document
 * is tested against seeded fixtures. */
export const SUPPORTED_GENERATION_SQL = `EXISTS (
  SELECT 1 FROM cloud_workspace_computer_sources source
  JOIN cloud_computer_v2_builds build ON build.id=source.build_id AND build.org_id=source.org_id AND build.config_id=source.config_id
  JOIN cloud_computer_templates template ON template.build_id=source.build_id AND template.org_id=source.org_id
  JOIN cloud_runtime_base_images base ON base.base_image_id=build.base_image_id AND base.provider='boat'
  JOIN cloud_runtime_bundles bundle ON bundle.runtime_id=build.runtime_id
  WHERE source.workspace_id=g.workspace_id AND source.generation=g.generation AND source.org_id=g.org_id
    AND g.runtime_profile='zeros-cloud-worker-v4' AND g.runtime_id IS NOT NULL
    AND g.runtime_manifest_sha256 IS NOT NULL AND g.runtime_engine_protocol_version>0
    AND base.base_image_id=g.runtime_base_image_id AND base.base_compatibility_id=g.runtime_base_compatibility_id
    AND build.state='succeeded' AND template.state='ready' AND template.stopped_at IS NOT NULL
    AND template.protected_contract_digest IS NOT NULL AND template.provider_resource_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND (g.image_ref='boat-template:'||template.provider_resource_id OR EXISTS (
      SELECT 1 FROM cloud_computer_template_snapshots snapshot WHERE snapshot.build_id=template.build_id
        AND snapshot.org_id=template.org_id AND snapshot.image_ref=g.image_ref AND snapshot.verified_at IS NOT NULL
        AND snapshot.source_sandbox_id=template.provider_resource_id AND snapshot.account_scope=template.account_scope
        AND snapshot.billing_org=template.billing_org AND snapshot.manifest_sha256=template.manifest_sha256))
    AND build.repository_manifest IS NOT NULL
    AND coalesce((SELECT jsonb_agg(jsonb_build_object('id',repo.repository_id,'owner',repo.repository_owner,'name',repo.repository_name) ORDER BY repo.position)
      FROM cloud_computer_v2_config_repositories repo WHERE repo.config_id=source.config_id AND repo.org_id=source.org_id),'[]'::jsonb)
      =coalesce((SELECT jsonb_agg(item.value-'sha' ORDER BY item.position)
        FROM jsonb_array_elements(build.repository_manifest) WITH ORDINALITY item(value,position)),'[]'::jsonb)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(build.repository_manifest) item
      WHERE NOT coalesce(item->>'id' ~ '^[1-9][0-9]{0,39}$' AND item->>'sha' ~ '^[a-f0-9]{40}$'
        AND item->>'owner' ~ '^[a-z0-9_.-]{1,100}$' AND item->>'name' ~ '^[a-z0-9_.-]{1,100}$'
        AND item->>'owner' NOT IN ('.','..') AND item->>'name' NOT IN ('.','..'),false))
)`;

/** Scopes from the same role predicates the workspace document projects
 * (routes.ts: canWrite/canEdit/canManage), so the token grants exactly what
 * the UI shows. */
export function capabilityScopesForRole(role: Role, supported: boolean, executable: boolean): string[] {
  const scopes = ["ws:read"];
  if (executable && ["prompter", "developer", "manager", "owner"].includes(role)) scopes.push("ws:prompt");
  if (executable && ["developer", "manager", "owner"].includes(role)) scopes.push("ws:edit");
  if (supported && ["manager", "owner"].includes(role)) scopes.push("ws:manage");
  return scopes.sort();
}

/** Engine-held token (aud zeros:api) for the current engine instance. The
 * caller authenticates the engine first (uplink hello or the REST fallback's
 * heartbeat credential plus boot id); this reads the facts once and fails
 * closed. */
export async function issueEngineCapability(
  tx: Tx,
  store: CapabilitySigningKeyStore,
  issuer: string,
  scope: { organizationId: string; workspaceId: string; generation: number; engineInstanceId: string },
): Promise<IssuedCapability> {
  if (!store.signer()) throw new CapabilityIssuerUnavailableError();
  const row = (await tx.query<{ authority_epoch: string }>(
    `SELECT workspace.authority_epoch
     FROM cloud_workspaces workspace
     JOIN cloud_workspace_engine_instances engine ON engine.id=$4 AND engine.workspace_id=workspace.id
       AND engine.org_id=workspace.org_id AND engine.generation=workspace.current_generation
       AND engine.state='ready' AND engine.revoked_at IS NULL AND engine.final_checkpoint_at IS NULL
       AND engine.lease_expires_at>clock_timestamp()
     WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.current_generation=$3 AND workspace.deleted_at IS NULL`,
    [scope.workspaceId, scope.organizationId, scope.generation, scope.engineInstanceId],
  )).rows[0];
  // No live row is a definitive denial (stale generation, revoked or fenced
  // engine): the uplink maps it to 4403, not a retry.
  if (!row) throw new CapabilityIssuanceError("cloud_workspace_not_found");
  const authorityEpoch = Number(row.authority_epoch);
  if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch < 1) throw new CapabilityIssuerUnavailableError();
  const nowSeconds = Math.floor(Date.now() / 1000);
  return sign(store, {
    ...baseClaims(issuer, scope),
    aud: "zeros:api",
    sub: `engine:${scope.engineInstanceId}`,
    knd: "engine",
    ein: scope.engineInstanceId,
    scp: [...CAPABILITY_ENGINE_SCOPES].sort(),
    ep: { wa: authorityEpoch },
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + CAPABILITY_TOKEN_LIFETIME_SECONDS,
  });
}

export type ClientCapabilityRequest = {
  organizationId: string;
  workspaceId: string;
  actorUserId: string;
  /** Registered device; must be trusted and unrevoked. */
  deviceId: string;
  /** auth_sessions.id of the caller's CP session. */
  sessionId: string;
  audience: Extract<CapabilityAudience, "zeros:engine" | "zeros:realtime">;
};

/** Client token (S1 "Issuance"): one statement reads the role, every epoch,
 * the device, the session and the current engine instance; a missing fact
 * denies or fails closed. The caller has already verified the session bearer
 * and the device proof. */
export async function issueClientCapability(
  tx: Tx,
  store: CapabilitySigningKeyStore,
  issuer: string,
  request: ClientCapabilityRequest,
): Promise<IssuedCapability> {
  if (!store.signer()) throw new CapabilityIssuerUnavailableError();
  const row = (await tx.query<{
    generation: number; authority_epoch: string; access_revision: string; role: string | null;
    provider: string; sandbox_class: string | null; credential_source: string | null; supported_generation: boolean;
    member_epoch: string | null; auth_revision: string; account_live: boolean;
    device_trusted: boolean; device_key_version: string | null; device_public_key: Buffer | null;
    session_expires_at: Date | null; session_live: boolean;
    guest_expires_at: Date | null; engine_instance_id: string | null;
  }>(
    `SELECT workspace.current_generation AS generation, workspace.authority_epoch, workspace.access_revision,
       cloud_workspace_actor_role(workspace.id, $3) AS role,
       g.provider, g.sandbox_class,
       (SELECT connection.credential_source FROM provider_connections connection
         WHERE connection.id=g.provider_connection_id AND connection.org_id=workspace.org_id) AS credential_source,
       ${SUPPORTED_GENERATION_SQL} AS supported_generation,
       (SELECT member.epoch FROM cloud_capability_member_epochs member
         WHERE member.org_id=workspace.org_id AND member.user_id=$3) AS member_epoch,
       account.auth_revision, (account.auth_status='active' AND account.deleted_at IS NULL) AS account_live,
       (device.trust_state='trusted' AND device.revoked_at IS NULL) AS device_trusted,
       device.key_version AS device_key_version, device.public_key AS device_public_key,
       session.provider_session_expires_at AS session_expires_at,
       (session.status='active' AND session.revoked_at IS NULL) AS session_live,
       (SELECT min(grant_row.expires_at) FROM cloud_workspace_guest_grants grant_row
         WHERE grant_row.workspace_id=workspace.id AND grant_row.org_id=workspace.org_id AND grant_row.user_id=$3
           AND grant_row.revoked_at IS NULL AND grant_row.expires_at>clock_timestamp()) AS guest_expires_at,
       (SELECT engine.id FROM cloud_workspace_engine_instances engine
         WHERE engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id
           AND engine.generation=workspace.current_generation AND engine.state='ready'
           AND engine.revoked_at IS NULL AND engine.final_checkpoint_at IS NULL
           AND engine.lease_expires_at>clock_timestamp()
         ORDER BY engine.created_at DESC LIMIT 1) AS engine_instance_id
     FROM cloud_workspaces workspace
     JOIN cloud_workspace_generations g ON g.workspace_id=workspace.id AND g.generation=workspace.current_generation
     JOIN users account ON account.id=$3
     LEFT JOIN devices device ON device.id=$4 AND device.user_id=$3
     LEFT JOIN auth_sessions session ON session.id=$5 AND session.user_id=$3
     WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.deleted_at IS NULL`,
    [request.workspaceId, request.organizationId, request.actorUserId, request.deviceId, request.sessionId],
  )).rows[0];
  if (!row) throw new CapabilityIssuanceError("cloud_workspace_not_found");
  const role = row.role as Role | null;
  if (!row.account_live || !role) throw new CapabilityIssuanceError("workspace_role_required");
  if (!row.device_trusted || !row.device_public_key || row.device_public_key.length !== 32) {
    throw new CapabilityIssuanceError("workspace_replica_device_proof_rejected");
  }
  if (!row.session_live) throw new CapabilityIssuanceError("capability_revoked");
  const authorityEpoch = Number(row.authority_epoch), accessRevision = Number(row.access_revision);
  const memberEpoch = Number(row.member_epoch ?? "1"), authRevision = Number(row.auth_revision);
  const deviceKeyVersion = Number(row.device_key_version);
  if (![authorityEpoch, accessRevision, memberEpoch, authRevision, deviceKeyVersion].every(Number.isSafeInteger) ||
      authorityEpoch < 1 || accessRevision < 1 || memberEpoch < 1 || authRevision < 1 || deviceKeyVersion < 1) {
    throw new CapabilityIssuerUnavailableError();
  }
  const supported = isSupportedCloudWorkspaceProviderBinding({
    provider: row.provider, sandboxClass: row.sandbox_class ?? undefined, credentialSource: row.credential_source ?? undefined,
  });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const deadlineMs = Math.min(
    row.session_expires_at?.getTime() ?? Number.POSITIVE_INFINITY,
    row.guest_expires_at?.getTime() ?? Number.POSITIVE_INFINITY,
  );
  const exp = Math.min(nowSeconds + CAPABILITY_TOKEN_LIFETIME_SECONDS, Math.floor(deadlineMs / 1000));
  if (exp <= nowSeconds) throw new CapabilityIssuanceError("capability_expired");
  return sign(store, {
    ...baseClaims(issuer, { organizationId: request.organizationId, workspaceId: request.workspaceId, generation: row.generation }),
    aud: request.audience,
    sub: `user:${request.actorUserId}`,
    knd: "client",
    ...(row.engine_instance_id ? { ein: row.engine_instance_id } : {}),
    role,
    scp: capabilityScopesForRole(role, supported, supported && row.supported_generation),
    ep: { wa: authorityEpoch, wr: accessRevision, me: memberEpoch, ac: authRevision, dk: deviceKeyVersion },
    sid: request.sessionId,
    did: request.deviceId,
    cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: row.device_public_key.toString("base64url") } },
    iat: nowSeconds,
    nbf: nowSeconds,
    exp,
  });
}
