// Append-only audit trail. Call inside the same transaction as the
// mutation it records — an audited action either fully happened or didn't.

import type { Tx } from "./db.js";

export async function audit(
  tx: Tx,
  teamId: string,
  actorId: string | null,
  action: string,
  subject: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (team_id, actor_id, action, subject)
     VALUES ($1, $2, $3, $4)`,
    [teamId, actorId, action, JSON.stringify(subject)],
  );
}
