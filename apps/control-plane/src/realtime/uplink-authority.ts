import { createHash } from "node:crypto";
import type pg from "pg";

import { withSystemTx } from "../db.js";
import {
  CloudWorkspaceEngineAuthorityError,
  readCurrentCloudEngineAuthority,
} from "../cloud-workspaces/engine-authority.js";
import type { UplinkSecurityAlerts } from "./uplink-alerts.js";

export type UplinkIdentity = Readonly<{
  workspaceId: string;
  organizationId: string;
  generation: number;
  engineInstanceId: string;
  bootId: string;
}>;

export type UplinkAuthorityResult =
  | { ok: true; accountUserId: string; leaseExpiresAtMs: number }
  /** `unauthenticated`: the read succeeded and no engine holds this
   * credential (4401). `authority`: the credential is known but the engine,
   * generation or workspace is not current (4403). `boot_mismatch`: current
   * credential, unregistered bootId (4403 plus a security event).
   * `unavailable`: the read could not complete (1011). */
  | { ok: false; reason: "unauthenticated" | "authority" | "boot_mismatch" | "unavailable" };

export interface UplinkAuthority {
  verify(identity: UplinkIdentity, heartbeatToken: string): Promise<UplinkAuthorityResult>;
}

/** One consistent read of the engine's current authority, the same
 * projection short-lived engine reads use, plus the registered bootId
 * (`cloud_workspace_engine_instances.runtime_boot_id`). A rejection adds one
 * statement in the same transaction, to tell an unknown credential from a
 * stale engine. The read always goes to SQL, never the in-process authority
 * cache: a notification-driven recheck may run before that cache's own
 * invalidation for the same commit has arrived. */
export class DatabaseUplinkAuthority implements UplinkAuthority {
  constructor(private readonly options: {
    pool: pg.Pool;
    workosEnabled: boolean;
    alerts?: UplinkSecurityAlerts;
  }) {}

  async verify(identity: UplinkIdentity, heartbeatToken: string): Promise<UplinkAuthorityResult> {
    let outcome: { read: Awaited<ReturnType<typeof readCurrentCloudEngineAuthority>> } | { known: boolean };
    try {
      outcome = await withSystemTx(this.options.pool, async tx => {
        try {
          return { read: await readCurrentCloudEngineAuthority(tx, {
            workspaceId: identity.workspaceId, organizationId: identity.organizationId, generation: identity.generation,
            engineInstanceId: identity.engineInstanceId, heartbeatToken, workosEnabled: this.options.workosEnabled,
            cache: "bypass",
          }) };
        } catch (error) {
          if (!(error instanceof CloudWorkspaceEngineAuthorityError)) throw error;
          // Same transaction: a rejected hello costs one round trip set, so
          // unauthenticated dials cannot buy two transactions each.
          const known = await tx.query("SELECT 1 FROM cloud_workspace_engine_instances WHERE heartbeat_token_hash = $1",
            [createHash("sha256").update(heartbeatToken, "utf8").digest()]);
          return { known: (known.rowCount ?? 0) > 0 };
        }
      }, { consistentRead: true });
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (!("read" in outcome)) return { ok: false, reason: outcome.known ? "authority" : "unauthenticated" };
    const read = outcome.read;
    if (read.runtimeBootId !== identity.bootId) {
      this.options.alerts?.raise("uplink_boot_mismatch", identity);
      return { ok: false, reason: "boot_mismatch" };
    }
    return { ok: true, accountUserId: read.accountUserId, leaseExpiresAtMs: read.leaseExpiresAtMs };
  }
}
