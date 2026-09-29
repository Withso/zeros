import type pg from 'pg';
/** Mandatory final transaction of an operator backup restore, before starting
 * any runtime process. Snapshot material cannot prove exclusive seed ownership. */
export async function quarantineRestoredConnections(pool:pg.Pool) {
  const tx=await pool.connect();
  try {
    await tx.query("BEGIN; SELECT pg_advisory_xact_lock(730318513); SELECT set_config('dev_connections.authority','broker',true)");
    await tx.query('LOCK TABLE dev_connections.generations,dev_connections.connections,dev_connections.bindings,dev_connections.refresh_attempts IN ACCESS EXCLUSIVE MODE');
    await tx.query("INSERT INTO dev_connections.generation_revocations(id) SELECT id FROM dev_connections.generations ON CONFLICT DO NOTHING");
    await tx.query('UPDATE dev_connections.generations SET revoked_at=coalesce(revoked_at,clock_timestamp())');
    await tx.query('UPDATE dev_connections.connections SET revoked_at=coalesce(revoked_at,clock_timestamp()),revision=revision+1');
    await tx.query('UPDATE dev_connections.organization_consents SET revoked_at=coalesce(revoked_at,clock_timestamp()),revision=revision+1');
    await tx.query("UPDATE dev_connections.refresh_attempts SET state=CASE WHEN state='reserved' THEN 'abandoned' ELSE 'uncertain' END WHERE state IN ('reserved','dispatched')");
    await tx.query("WITH revoked AS (UPDATE dev_connections.bindings SET revoked_at=clock_timestamp() RETURNING generation_id,id) INSERT INTO dev_connections.revocation_outbox(generation_id,binding_id,reason) SELECT generation_id,id,'disconnect' FROM revoked");
    await tx.query('DELETE FROM dev_connections.connection_versions');
    await tx.query('COMMIT');
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
