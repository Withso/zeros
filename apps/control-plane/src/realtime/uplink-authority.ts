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
 * (`cloud_workspace_engine_instances.runtime_boot_id`). Only a rejection
 * takes a second read, to tell an unknown credential from a stale engine. */
export class DatabaseUplinkAuthority implements UplinkAuthority {
  constructor(private readonly options: {
    pool: pg.Pool;
    workosEnabled: boolean;
    alerts?: UplinkSecurityAlerts;
  }) {}

  async verify(identity: UplinkIdentity, heartbeatToken: string): Promise<UplinkAuthorityResult> {
    let read: Awaited<ReturnType<typeof readCurrentCloudEngineAuthority>>;
    try {
      read = await withSystemTx(this.options.pool, tx => readCurrentCloudEngineAuthority(tx, {
        workspaceId: identity.workspaceId, organizationId: identity.organizationId, generation: identity.generation,
        engineInstanceId: identity.engineInstanceId, heartbeatToken, workosEnabled: this.options.workosEnabled,
      }), { consistentRead: true });
    } catch (error) {
      if (!(error instanceof CloudWorkspaceEngineAuthorityError)) return { ok: false, reason: "unavailable" };
      try {
        const known = await withSystemTx(this.options.pool, tx => tx.query(
          "SELECT 1 FROM cloud_workspace_engine_instances WHERE heartbeat_token_hash = $1",
          [createHash("sha256").update(heartbeatToken, "utf8").digest()],
        ));
        return { ok: false, reason: known.rowCount ? "authority" : "unauthenticated" };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    }
    if (read.runtimeBootId !== identity.bootId) {
      this.options.alerts?.raise("uplink_boot_mismatch", identity);
      return { ok: false, reason: "boot_mismatch" };
    }
    return { ok: true, accountUserId: read.accountUserId, leaseExpiresAtMs: read.leaseExpiresAtMs };
  }
}
