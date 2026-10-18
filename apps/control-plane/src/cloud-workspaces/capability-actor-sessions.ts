import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { authorizeCloudWorkspaceActor } from "./actors.js";
import type { CloudActorEngineScope } from "./actor-sessions.js";
import { capabilityActorSessionsEnabled } from "./actor-session-authority.js";
import { CapabilityClaimsSchema, CAPABILITY_KEY_ID_PATTERN, type CapabilityClaims } from "./capability-contract.js";
import { CAPABILITY_SESSION_AUDIENCE, CapabilitySessionResponseSchema, type CapabilitySessionResponse } from "./capability-actor-contract.js";
import type { CapabilityRoute } from "./capability-verifier.js";
import { assertCloudEngineAuthorityDeadline, assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import { requireSupportedCloudWorkspaceGeneration } from "./supported-generation.js";
import { readCurrentCloudAgentBootBinding } from "./agent-boot-credentials.js";

/** Constructed only after the internal route independently verifies S1 + PoP.
 * Token bytes and proof signatures never enter persistence. */
export type VerifiedCapabilitySessionInput = CloudActorEngineScope & {
  claims: CapabilityClaims; keyId: string; tokenSha256: string; route: CapabilityRoute; signal?: AbortSignal;
};
export type CapabilitySessionRenewalInput = VerifiedCapabilitySessionInput & { actorSessionId: string; expectedRevision: number };
type SessionRow = {
  id: string; actor_fingerprint: string; capability_claims: CapabilityClaims;
  capability_key_id: string; capability_token_sha256: Buffer; capability_revision: string; capability_route: CapabilityRoute;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function rejected(): never { throw new HttpError(401, "cloud_actor_admission_rejected", "Workspace actor admission was rejected"); }

/** Canonical scope set and all recognized claims, including future epochs.
 * Renewal may change only issuance times, JTI and signing key. */
function binding(claims: CapabilityClaims): string {
  const { iat: _iat, nbf: _nbf, exp: _exp, jti: _jti, ...identity } = claims;
  return JSON.stringify({ ...identity, scp: [...identity.scp].sort(), ep: Object.fromEntries(Object.entries(identity.ep).sort()) });
}

export class DatabaseCapabilityActorSessionService {
  constructor(private readonly pool: pg.Pool, private readonly workosEnabled: boolean) {}

  admit(input: VerifiedCapabilitySessionInput): Promise<CapabilitySessionResponse> { return this.commit(input); }
  renew(input: CapabilitySessionRenewalInput): Promise<CapabilitySessionResponse> { return this.commit(input, input); }

  private async commit(input: VerifiedCapabilitySessionInput, renewal?: CapabilitySessionRenewalInput): Promise<CapabilitySessionResponse> {
    const parsed = CapabilityClaimsSchema.safeParse(input.claims);
    if (!parsed.success) rejected();
    const claims = { ...parsed.data, scp: [...parsed.data.scp].sort() };
    const userId = claims.sub.slice(5), { sid, did, role, cnf } = claims;
    if (!this.workosEnabled || !capabilityActorSessionsEnabled(input.organizationId) ||
        claims.knd !== "client" || claims.aud !== "zeros:engine" || !sid || !did || !role || !cnf ||
        !UUID.test(userId) || claims.org !== input.organizationId.toLowerCase() || claims.wsp !== input.workspaceId.toLowerCase() ||
        claims.gen !== input.generation || (claims.ein !== undefined && claims.ein !== input.engineInstanceId.toLowerCase()) ||
        !claims.scp.includes("ws:read") || !CAPABILITY_KEY_ID_PATTERN.test(input.keyId) || !/^[a-f0-9]{64}$/.test(input.tokenSha256) ||
        !["direct", "relay"].includes(input.route) || claims.exp > 253402300799 || claims.exp <= claims.iat || claims.exp - claims.iat > 300 ||
        (renewal && (!UUID.test(renewal.actorSessionId) || !Number.isSafeInteger(renewal.expectedRevision) || renewal.expectedRevision < 1))) rejected();
    const deadline = Math.min(claims.exp * 1000, Date.now() + 5_000);
    const monotonicDeadline = performance.now() + Math.max(0, deadline - Date.now());
    const live = () => {
      if (input.signal?.aborted || !capabilityActorSessionsEnabled(input.organizationId) ||
          Date.now() >= deadline || performance.now() >= monotonicDeadline) rejected();
    };
    live();
    const result = await withSystemTx(this.pool, async tx => {
      await tx.query("SET LOCAL statement_timeout = '5s'");
      const engine = await assertCurrentCloudEngineAuthority(tx, { ...input, workosEnabled: this.workosEnabled, lock: "share" });
      await requireSupportedCloudWorkspaceGeneration(tx, input);
      const boot = await readCurrentCloudAgentBootBinding(tx, { workspaceId: input.workspaceId, organizationId: input.organizationId });
      if (boot.mode !== "legacy" && (boot.binding.writerState !== "active" || boot.binding.status !== "current" ||
          boot.binding.generation !== input.generation || boot.binding.engineInstanceId !== input.engineInstanceId.toLowerCase())) rejected();
      live();
      if (claims.ep.wa !== engine.authorityEpoch) rejected();
      // Serialize admission capacity (legacy issue holds the workspace update
      // lock; legacy capability admission shares this advisory fence).
      if (!renewal) await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`cloud-actor-session-limit:${input.workspaceId.toLowerCase()}`]);
      const authority = await authorizeCloudWorkspaceActor(tx, { workspaceId: input.workspaceId,
        organizationId: input.organizationId, actorUserId: userId, capability: "read" });
      if (authority.role !== role) rejected();
      let row: SessionRow;
      let signingKids = [input.keyId];
      if (renewal) {
        const current = (await tx.query<SessionRow>(`SELECT session.* FROM cloud_workspace_actor_sessions session
          WHERE session.id=$1 AND session.workspace_id=$2 AND session.org_id=$3 AND session.generation=$4
            AND session.engine_instance_id=$5 AND session.session_kind='capability-v1'
            AND session.revoked_at IS NULL AND session.consumed_at IS NOT NULL
          FOR NO KEY UPDATE OF session`,
        [renewal.actorSessionId, input.workspaceId, input.organizationId, input.generation, input.engineInstanceId])).rows[0];
        if (!current || current.actor_fingerprint !== authority.fingerprint || current.capability_route !== input.route ||
            binding(CapabilityClaimsSchema.parse(current.capability_claims)) !== binding(claims)) rejected();
        // Recovery after signed expiry is a fresh full proof, never a grace
        // period for CP operations. A revoked source/key cannot be rescued.
        signingKids = [current.capability_key_id, input.keyId];
        await this.lockSources(tx, sid, did, userId, signingKids);
        if (!(await tx.query(`SELECT 1 FROM cloud_workspace_actor_sessions session WHERE id=$1
          AND cloud_workspace_actor_session_source_live(session,'ws:read',false,false)`, [current.id])).rowCount) rejected();
        const revision = Number(current.capability_revision);
        if (current.capability_token_sha256.toString("hex") === input.tokenSha256) {
          if (current.capability_key_id !== input.keyId || !isDeepStrictEqual(current.capability_claims, claims) ||
              (renewal.expectedRevision !== revision && renewal.expectedRevision !== revision - 1)) rejected();
          row = current; // Lost ACK + fresh nonce: same committed expiry/revision.
        } else {
          if (renewal.expectedRevision !== revision || claims.exp <= current.capability_claims.exp ||
              claims.iat < current.capability_claims.iat || claims.jti === current.capability_claims.jti) rejected();
          row = (await tx.query<SessionRow>(`UPDATE cloud_workspace_actor_sessions SET
            capability_claims=$2,capability_key_id=$3,capability_token_sha256=$4,capability_revision=capability_revision+1,
            session_expires_at=to_timestamp($5),last_renewed_at=clock_timestamp()
            WHERE id=$1 AND revoked_at IS NULL AND capability_revision=$6 AND to_timestamp($5)>clock_timestamp()
            RETURNING *`, [current.id, claims, input.keyId, Buffer.from(input.tokenSha256, "hex"), claims.exp, revision])).rows[0] ?? rejected();
        }
      } else {
        await this.lockSources(tx, sid, did, userId, [input.keyId]);
        const count = (await tx.query<{ count: string }>(`SELECT count(*) FROM cloud_workspace_actor_sessions
          WHERE workspace_id=$1 AND revoked_at IS NULL AND session_expires_at>clock_timestamp()
            AND ((consumed_at IS NULL AND admission_expires_at>clock_timestamp()) OR
              (session_kind='capability-v1' AND consumed_at IS NOT NULL) OR last_renewed_at>clock_timestamp()-interval '30 seconds')`,
        [input.workspaceId])).rows[0]!;
        if (Number(count.count) >= 100) throw new HttpError(429, "cloud_actor_session_limit", "Workspace connection limit reached");
        row = (await tx.query<SessionRow>(`INSERT INTO cloud_workspace_actor_sessions
          (id,workspace_id,org_id,generation,engine_instance_id,actor_user_id,device_id,device_key_version,
           authority_epoch,actor_fingerprint,actor_role,admission_expires_at,session_expires_at,consumed_at,last_renewed_at,
           session_kind,capability_source_session_id,capability_claims,capability_key_id,capability_token_sha256,capability_revision,capability_route)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12),to_timestamp($12),clock_timestamp(),clock_timestamp(),
            'capability-v1',$13,$14,$15,$16,1,$17) RETURNING *`,
        [randomUUID(), input.workspaceId, input.organizationId, input.generation, input.engineInstanceId, userId, did,
          claims.ep.dk, engine.authorityEpoch, authority.fingerprint, role, claims.exp, sid, claims, input.keyId,
          Buffer.from(input.tokenSha256, "hex"), input.route])).rows[0]!;
      }
      // Re-read committed DB facts, including the signing key, rather than
      // relying on the preceding verifier's key/placement cache.
      if (!(await tx.query(`SELECT 1 FROM cloud_workspace_actor_sessions session WHERE id=$1
        AND cloud_workspace_actor_session_source_live(session,'ws:read',true,true)`, [row.id])).rowCount) rejected();
      // A retiring old key's wall deadline can pass while its replacement is
      // committed. Both original and replacement keys must still be live.
      await this.lockSigningKeys(tx, signingKids);
      await assertCloudEngineAuthorityDeadline(tx, input.engineInstanceId, this.workosEnabled);
      live();
      return CapabilitySessionResponseSchema.parse({
        version: 1, audience: CAPABILITY_SESSION_AUDIENCE, mode: "capability-session-v1", admitted: true,
        workspaceId: claims.wsp, organizationId: claims.org, generation: claims.gen, engineInstanceId: input.engineInstanceId.toLowerCase(),
        authorityEpoch: claims.ep.wa, actorSessionId: row.id, accountUserId: userId, deviceId: did,
        role, fingerprint: row.actor_fingerprint, route: row.capability_route,
        capability: { claims: row.capability_claims, keyId: row.capability_key_id,
          tokenSha256: row.capability_token_sha256.toString("hex"), revision: Number(row.capability_revision) },
      });
    });
    // COMMIT precedes the response. A held SQL/commit reply, abort or flag
    // disable cannot turn an expired observation into a successful ACK.
    live();
    return result;
  }

  private async lockSources(tx: Tx, sourceId: string, deviceId: string, userId: string, kids: string[]): Promise<void> {
    await tx.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [userId]);
    await tx.query("SELECT id FROM user_identities WHERE user_id=$1 AND provider='workos' FOR SHARE", [userId]);
    await tx.query("SELECT id FROM auth_sessions WHERE id=$1 AND user_id=$2 FOR SHARE", [sourceId, userId]);
    await tx.query("SELECT id FROM devices WHERE id=$1 AND user_id=$2 FOR SHARE", [deviceId, userId]);
    await this.lockSigningKeys(tx, kids);
  }

  private async lockSigningKeys(tx: Tx, kids: string[]): Promise<void> {
    const keys = (await tx.query<{ live: boolean }>("SELECT cloud_capability_actor_signing_keys_live($1::text[]) AS live", [[...new Set(kids)]])).rows[0];
    if (keys?.live !== true) rejected();
  }
}
