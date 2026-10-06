import type { Tx } from "../db.js";

/** Hint only. PostgreSQL publishes after the caller's transaction commits;
 * rollback produces no hint. The listener always rereads durable eligibility. */
export async function notifyRuntimeStaging(tx: Tx): Promise<void> {
  await tx.query("SELECT pg_notify('zeros_cloud_runtime_staging_work','')");
}
