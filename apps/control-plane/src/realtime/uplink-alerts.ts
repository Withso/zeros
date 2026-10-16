import type pg from "pg";

import { audit } from "../audit.js";
import { withSystemTx } from "../db.js";
import type { UplinkIdentity } from "./uplink-authority.js";

export type UplinkSecurityAlertKind = "uplink_boot_mismatch" | "uplink_supersede_churn" | "uplink_supersede_address";

export interface UplinkSecurityAlerts {
  raise(kind: UplinkSecurityAlertKind, identity: UplinkIdentity, detail?: Record<string, string | number>): void;
}

const ALERT_INTERVAL_MS = 5 * 60_000;

/** Operator security events for the uplink. They are written to the
 * organization's audit log and logged with a stable `[security]` tag that
 * log alerting pages on. They deliberately do not use `security_events`,
 * which is the client-delivered authorization invalidation outbox. One alert
 * per engine and kind per window, so a leaked credential cannot turn
 * rejected hellos into database write load. */
export class AuditUplinkSecurityAlerts implements UplinkSecurityAlerts {
  private readonly raisedAt = new Map<string, number>();
  constructor(private readonly options: {
    pool: pg.Pool | null;
    now?: () => number;
    log?: (message: string) => void;
  }) {}

  raise(kind: UplinkSecurityAlertKind, identity: UplinkIdentity, detail: Record<string, string | number> = {}): void {
    const now = (this.options.now ?? Date.now)();
    const key = `${kind}:${identity.engineInstanceId}`;
    const last = this.raisedAt.get(key);
    if (last !== undefined && now - last < ALERT_INTERVAL_MS) return;
    if (this.raisedAt.size >= 10_000) this.raisedAt.clear();
    this.raisedAt.set(key, now);
    (this.options.log ?? console.error)(
      `[security] ${kind} workspace=${identity.workspaceId} engine=${identity.engineInstanceId} generation=${identity.generation}`,
    );
    const pool = this.options.pool;
    if (!pool) return;
    void withSystemTx(pool, tx => audit(tx, identity.organizationId, null, `security.${kind}`, {
      workspaceId: identity.workspaceId, generation: identity.generation,
      engineInstanceId: identity.engineInstanceId, bootId: identity.bootId, ...detail,
    })).catch(() => {
      // The tagged log line above is the alert of record while the database is down.
    });
  }
}
