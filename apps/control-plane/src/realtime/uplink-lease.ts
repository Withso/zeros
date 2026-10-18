import { createHash } from "node:crypto";
import type pg from "pg";

import { withSystemTx } from "../db.js";
import { CloudWorkspaceEngineAuthorityError, assertCurrentCloudEngineAuthority } from "../cloud-workspaces/engine-authority.js";
import type { UplinkIdentity } from "./uplink-authority.js";

/** The engine lease one uplink renewal grants (S2 `lease.v1`). The uplink
 * renews it every watermark interval (5 min), so at least 31 minutes remain
 * when an outage starts: a 30-minute control-plane outage (the S1 outage
 * rule) lets no lease lapse. */
export const UPLINK_ENGINE_LEASE_MS = 36 * 60_000;

export type UplinkLeaseRenewal =
  | { ok: true; leaseExpiresAtMs: number }
  /** `authority`: the engine, its boot, generation or workspace is no longer
   * current, or its lease already lapsed; a lapsed lease is never revived
   * (4403). `unavailable`: the renewal could not complete; the uplink stays
   * open and the next tick retries. */
  | { ok: false; reason: "authority" | "unavailable" };

export interface UplinkLeaseStore {
  renew(identity: UplinkIdentity, heartbeatToken: string): Promise<UplinkLeaseRenewal>;
}

/** One system transaction: the exclusive authority fence every engine
 * mutation takes (organization, workspace, engine), then a renewal that only
 * moves the lease later. It changes `last_heartbeat_at`, `lease_expires_at`
 * and `updated_at` only, so the authority-cache, engine-health and uplink
 * teardown triggers stay silent. */
export class DatabaseUplinkLeaseStore implements UplinkLeaseStore {
  constructor(private readonly options: { pool: pg.Pool; workosEnabled: boolean }) {}

  async renew(identity: UplinkIdentity, heartbeatToken: string): Promise<UplinkLeaseRenewal> {
    let leaseExpiresAtMs: number | null;
    try {
      leaseExpiresAtMs = await withSystemTx(this.options.pool, async tx => {
        // A renewal waiting behind a lifecycle lock is retried on the next
        // tick rather than holding a pool connection.
        await tx.query("SET LOCAL lock_timeout = '2s'");
        try {
          await assertCurrentCloudEngineAuthority(tx, {
            workspaceId: identity.workspaceId, organizationId: identity.organizationId, generation: identity.generation,
            engineInstanceId: identity.engineInstanceId, heartbeatToken, workosEnabled: this.options.workosEnabled,
          });
        } catch (error) {
          if (error instanceof CloudWorkspaceEngineAuthorityError) return null;
          throw error;
        }
        const renewed = await tx.query<{ lease_expires_at: Date }>(
          `UPDATE cloud_workspace_engine_instances
           SET last_heartbeat_at = clock_timestamp(),
               lease_expires_at = greatest(lease_expires_at, clock_timestamp() + ($7::bigint * interval '1 millisecond')),
               updated_at = now()
           WHERE id = $1 AND workspace_id = $2 AND org_id = $3 AND generation = $4
             AND runtime_boot_id = $5 AND heartbeat_token_hash = $6
             AND state = 'ready' AND revoked_at IS NULL AND final_checkpoint_at IS NULL
             AND lease_expires_at > clock_timestamp()
           RETURNING lease_expires_at`,
          [identity.engineInstanceId, identity.workspaceId, identity.organizationId, identity.generation, identity.bootId,
            createHash("sha256").update(heartbeatToken, "utf8").digest(), UPLINK_ENGINE_LEASE_MS],
        );
        return renewed.rows[0]?.lease_expires_at.getTime() ?? null;
      });
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    return leaseExpiresAtMs === null ? { ok: false, reason: "authority" } : { ok: true, leaseExpiresAtMs };
  }
}
