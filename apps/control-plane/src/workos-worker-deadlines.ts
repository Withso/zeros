import type pg from "pg";
import { withSystemTx } from "./db.js";

export type WorkOSWork = "commands" | "notifications" | "deletions";

/** Scheduling hints only. The unchanged claims recheck ordering, provider
 * readiness, deletion authority and leases before performing any work. */
export async function readWorkOSWorkerDeadlines(
  pool: pg.Pool,
  includeDeletions: boolean,
): Promise<Partial<Record<WorkOSWork, number>>> {
  return withSystemTx(
    pool,
    async (tx) => {
      const started = Date.now();
      const result = await tx.query<{
        kind: WorkOSWork;
        delay_ms: string | null;
      }>(`
      SELECT kind,extract(epoch FROM (min(due_at)-now()))*1000 AS delay_ms FROM (
        SELECT 'commands' AS kind,CASE WHEN c.state='queued' THEN c.next_attempt_at ELSE c.lease_expires_at END AS due_at
        FROM workos_command_outbox c WHERE c.state IN ('queued','processing')
          AND (c.operation IN ('organization.create','session.revoke','sessions.revoke_all','user.delete')
            OR c.organization_id IS NULL OR EXISTS (
              SELECT 1 FROM workos_organization_links ready WHERE ready.organization_id=c.organization_id
                AND ready.workos_organization_id IS NOT NULL AND ready.state IN ('active','deleting'))
            OR NOT EXISTS (SELECT 1 FROM workos_command_outbox provisioning WHERE provisioning.organization_id=c.organization_id
              AND provisioning.operation='organization.create' AND provisioning.state IN ('queued','processing')))
          AND NOT EXISTS (SELECT 1 FROM workos_command_outbox older WHERE older.ordering_key=c.ordering_key
            AND older.sequence<c.sequence AND older.state IN ('queued','processing'))
        UNION ALL SELECT 'notifications',CASE WHEN state='queued' THEN next_attempt_at ELSE lease_expires_at END
          FROM security_notification_outbox WHERE delivery_provider='resend' AND state IN ('queued','sending')
        ${
          includeDeletions
            ? `UNION ALL SELECT 'deletions',greatest(next_attempt_at,
          CASE WHEN state='scheduled' THEN purge_after ELSE lease_expires_at END)
          FROM deletion_requests WHERE (state IN ('scheduled','failed') AND attempt_count<20)
            OR (state IN ('purging','provider_deleting') AND attempt_count<=20)`
            : ""
        }
      ) work WHERE due_at IS NOT NULL GROUP BY kind`);
      const elapsed = Date.now() - started;
      return Object.fromEntries(
        result.rows
          .filter((row) => row.delay_ms !== null)
          .map((row) => [row.kind, Number(row.delay_ms) - elapsed]),
      );
    },
    { consistentRead: true },
  );
}
