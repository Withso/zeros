import type pg from "pg";

import { withSystemTx } from "../db.js";
import { CapabilityIssuanceError, issueEngineCapability } from "../cloud-workspaces/capability-issuer.js";
import type { CapabilitySigningKeyStore } from "../cloud-workspaces/capability-keys.js";
import type { RolloutFlagSnapshot } from "../rollout-flags.js";
import type { UplinkIdentity } from "./uplink-authority.js";
import type { UplinkAuthSnapshot, UplinkJwk, UplinkRevocation } from "./uplink-protocol.js";

/** Epochs, revocations and keys for the `auth` channel (S1). The capability
 * authority (track B) implements this; realtime never derives epochs itself. */
export interface UplinkAuthSource {
  /** The current JWKS: one to three keys (`next`, `current`, `retiring`). */
  keys(): Promise<readonly UplinkJwk[]>;
  /** Epochs for the S1 snapshot scope of the engine's workspace plus every
   * revocation since `authCursor`; `complete` when the cursor is too old. */
  snapshot(identity: UplinkIdentity, authCursor: string | undefined): Promise<UplinkAuthSnapshot>;
}

export type EngineCapabilityResult =
  | { ok: true; token: string; expiresAtMs: number }
  /** `authority`: the engine instance is no longer current (close 4403).
   * `unavailable`: the issuer could not answer; retried later. */
  | { ok: false; reason: "authority" | "unavailable" };

/** Engine `zeros:api` capabilities are signed by `api` from current
 * authority on request from realtime, never by realtime itself. */
export interface EngineCapabilityIssuer {
  issue(identity: UplinkIdentity): Promise<EngineCapabilityResult>;
}

/** S1 keeps a revocation entry for max token lifetime + outage grace + skew. */
export const UPLINK_AUTH_REVOCATION_RETENTION_MS = 36 * 60 * 1000;

/** The snapshot scope of one workspace (S1 "Snapshot scope"): every principal
 * who currently has access, plus every principal of the same organization
 * whose membership epoch moved inside the revocation retention window (a
 * removed member's old token must meet a raised `me`). Devices, account
 * epochs and revocations are listed for those principals only. Every snapshot
 * is complete: the epoch counters have no per-field timestamps, so a delta
 * cannot be derived honestly; the verifier's maximum merge makes a full
 * snapshot cheap and safe. */
const SNAPSHOT_SQL = `
WITH workspace_row AS (
  SELECT authority_epoch, access_revision FROM cloud_workspaces
  WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL
), principals AS (
  SELECT member.user_id FROM cloud_workspace_members member
  WHERE member.workspace_id=$1 AND member.org_id=$2
  UNION
  SELECT grant_row.user_id FROM cloud_workspace_guest_grants grant_row
  WHERE grant_row.workspace_id=$1 AND grant_row.org_id=$2
    AND grant_row.revoked_at IS NULL AND grant_row.expires_at>clock_timestamp()
  UNION
  SELECT member.user_id FROM organization_members member
  JOIN cloud_workspaces workspace ON workspace.id=$1 AND workspace.sharing_mode='organization'
  WHERE member.org_id=$2
  UNION
  SELECT epoch_row.user_id FROM cloud_capability_member_epochs epoch_row
  WHERE epoch_row.org_id=$2 AND epoch_row.updated_at>clock_timestamp()-make_interval(secs=>$3::double precision/1000)
), member_epochs AS (
  SELECT epoch_row.user_id, epoch_row.epoch FROM cloud_capability_member_epochs epoch_row
  WHERE epoch_row.org_id=$2 AND epoch_row.user_id IN (SELECT user_id FROM principals)
), account_epochs AS (
  SELECT account.id AS user_id, account.auth_revision AS epoch FROM users account
  WHERE account.id IN (SELECT user_id FROM principals)
), device_epochs AS (
  SELECT device.id AS device_id, device.user_id, device.key_version AS epoch, device.revoked_at
  FROM devices device WHERE device.user_id IN (SELECT user_id FROM principals)
), session_revocations AS (
  SELECT session.id, session.revoked_at FROM auth_sessions session
  WHERE session.user_id IN (SELECT user_id FROM principals) AND session.revoked_at IS NOT NULL
    AND session.revoked_at>clock_timestamp()-make_interval(secs=>$3::double precision/1000)
)
SELECT
  (SELECT row_to_json(workspace_row) FROM workspace_row) AS workspace,
  (SELECT coalesce(jsonb_object_agg(user_id, epoch), '{}') FROM member_epochs) AS members,
  (SELECT coalesce(jsonb_object_agg(user_id, epoch), '{}') FROM account_epochs) AS accounts,
  (SELECT coalesce(jsonb_object_agg(device_id, epoch), '{}') FROM device_epochs WHERE revoked_at IS NULL) AS devices,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'device', 'id', device_id, 'until',
       floor(extract(epoch FROM revoked_at)*1000)+$3)), '[]') FROM device_epochs
     WHERE revoked_at IS NOT NULL AND revoked_at>clock_timestamp()-make_interval(secs=>$3::double precision/1000)) AS device_revocations,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'session', 'id', id, 'until',
       floor(extract(epoch FROM revoked_at)*1000)+$3)), '[]') FROM session_revocations) AS session_revocations`;

/** Snapshot and key material for the uplink `auth` channel, backed by the
 * capability tables. Every read re-checks the `capabilities` flag so a
 * flag-off organization stays inert even on a mounted server. */
export class DatabaseUplinkAuthSource implements UplinkAuthSource {
  constructor(private readonly options: {
    pool: pg.Pool;
    keyStore: CapabilitySigningKeyStore;
    flags: RolloutFlagSnapshot;
  }) {}

  keys(): Promise<readonly UplinkJwk[]> {
    return Promise.resolve(this.options.keyStore.publicKeySet());
  }

  async snapshot(identity: UplinkIdentity, _authCursor: string | undefined): Promise<UplinkAuthSnapshot> {
    if (!this.options.flags.enabled(identity.organizationId, "capabilities")) {
      throw new Error("capabilities flag off");
    }
    const row = await withSystemTx(this.options.pool, async tx => (await tx.query<{
      workspace: { authority_epoch: string; access_revision: string } | null;
      members: Record<string, string>; accounts: Record<string, string>; devices: Record<string, string>;
      device_revocations: UplinkRevocation[]; session_revocations: UplinkRevocation[];
    }>(SNAPSHOT_SQL, [identity.workspaceId, identity.organizationId, UPLINK_AUTH_REVOCATION_RETENTION_MS])).rows[0]);
    if (!row?.workspace) throw new Error("workspace not found");
    const numbers = (entries: Record<string, string>) => Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [key, Number(value)]));
    return {
      epochs: {
        wa: Number(row.workspace.authority_epoch), wr: Number(row.workspace.access_revision),
        members: numbers(row.members), accounts: numbers(row.accounts), devices: numbers(row.devices),
      },
      revocations: [...row.device_revocations, ...row.session_revocations],
      authCursor: `t${Date.now()}`,
      complete: true,
    };
  }
}

/** Issues the handshake's `zeros:api` engine token from current authority. */
export class UplinkEngineCapabilityIssuer implements EngineCapabilityIssuer {
  constructor(private readonly options: {
    pool: pg.Pool;
    keyStore: CapabilitySigningKeyStore;
    issuer: string;
    flags: RolloutFlagSnapshot;
  }) {}

  async issue(identity: UplinkIdentity): Promise<EngineCapabilityResult> {
    const { pool, keyStore, issuer, flags } = this.options;
    if (!flags.enabled(identity.organizationId, "capabilities")) return { ok: false, reason: "unavailable" };
    try {
      const issued = await withSystemTx(pool, tx => issueEngineCapability(tx, keyStore, issuer, {
        organizationId: identity.organizationId, workspaceId: identity.workspaceId,
        generation: identity.generation, engineInstanceId: identity.engineInstanceId,
      }));
      return { ok: true, token: issued.token, expiresAtMs: issued.expiresAt.getTime() };
    } catch (error) {
      // A denied engine is a stale registration (4403); anything else is a
      // transient issuer failure and the server retries it.
      return { ok: false, reason: error instanceof CapabilityIssuanceError ? "authority" : "unavailable" };
    }
  }
}

/** The uplink's `auth` dependencies. Null keeps the uplink unmounted: the
 * frozen handshake cannot complete without keys and epochs, and an
 * organization without the `capabilities` flag must stay inert. Because the
 * flag snapshot is per-organization, the process-level gate mounts once any
 * organization has the flag on; per-organization admission still applies to
 * every handshake, key set, snapshot and issued token. */
export function uplinkCapabilityAuthority(options: {
  pool: pg.Pool;
  keyStore: CapabilitySigningKeyStore | null;
  issuer: string | null | undefined;
  flags: RolloutFlagSnapshot | null;
}): { source: UplinkAuthSource; issuer: EngineCapabilityIssuer } | null {
  if (!options.keyStore || !options.issuer || !options.flags?.anyEnabled("capabilities")) return null;
  const { pool, keyStore, issuer, flags } = options;
  return {
    source: new DatabaseUplinkAuthSource({ pool, keyStore, flags }),
    issuer: new UplinkEngineCapabilityIssuer({ pool, keyStore, issuer, flags }),
  };
}
