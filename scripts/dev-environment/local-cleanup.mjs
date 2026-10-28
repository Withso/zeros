import { assertLocalDatabaseOwner } from "./local-fixtures.mjs";

const SANDBOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const missing = error => error?.httpStatus === 404 || error?.code === "provider_not_found";

/** Lost create replies are recovered by exact instance names, never by a
 * prefix sweep or a retry that could allocate a new VM. An incomplete list
 * cannot certify absence. Keep both page count and repeated cursors bounded. */
export async function completeSandboxInventory(provider) {
  const rows = [], cursors = new Set(), ids = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor).replace(/[!'()*~]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}` : "";
    const result = await provider.request(`/sandboxes?limit=100${suffix}`);
    if (!Array.isArray(result?.sandboxes) || result.sandboxes.length > 100 || typeof result.pageInfo?.hasMore !== "boolean")
      throw new Error("Incomplete Boat inventory; local resources were preserved");
    for (const row of result.sandboxes) {
      if (!SANDBOX_ID.test(row?.id ?? "") || ids.has(row.id) || (row.name != null && typeof row.name !== "string"))
        throw new Error("Invalid Boat inventory; local resources were preserved");
      ids.add(row.id); rows.push({ id: row.id, name: row.name ?? null });
    }
    if (!result.pageInfo.hasMore) return rows;
    cursor = result.pageInfo.nextCursor;
    if (typeof cursor !== "string" || !cursor || cursor.length > 512 || cursors.has(cursor))
      throw new Error("Incomplete Boat inventory; local resources were preserved");
    cursors.add(cursor);
  }
  throw new Error("Boat inventory exceeds the reset limit; local resources were preserved");
}

/** A successful DELETE is only acceptance. Confirm with a separate GET and
 * keep the durable row on errors, timeouts or a still-visible allocation. */
async function deleteAndConfirm(provider, path, id, belongs = () => true) {
  try {
    let current;
    try { current = await provider.request(path); }
    catch (error) { if (missing(error)) return true; throw error; }
    if (!belongs(current)) return false;
    try { await provider.request(path, { method: "DELETE", confirmDelete: id }); }
    catch (error) { if (!missing(error)) throw error; }
    try { await provider.request(path); }
    catch (error) { if (missing(error)) return true; throw error; }
    return false;
  } catch { return false; } // Provider responses can contain secrets; return counts only.
}

/** The launcher has stopped the backend and holds its data-directory lock.
 * Fences and confirmations live in the local DB, so interruption is retried
 * without losing resource IDs. Nothing is created, resumed or re-hosted. */
export async function drainLocalCloudResources({ runtime, withSystemTx, request, provider, snapshotName, sandboxName }) {
  if (request.backendStopped !== true) throw new Error("Stop the local backend before deleting its cloud resources");
  await assertLocalDatabaseOwner(runtime, request);
  const tx = fn => withSystemTx(runtime, fn);
  const pending = new Set();
  const { workspaces, builds } = await tx(async client => {
    await client.query(`UPDATE cloud_v2_computer_builds SET
      cleanup_requested_at=coalesce(cleanup_requested_at,clock_timestamp()),
      state=CASE WHEN state IN ('queued','building') THEN 'cancelled' ELSE state END`);
    // A claimed create may still complete at Boat after the local process
    // dies. Preserve a five-minute dispatch horizon before inventory proves
    // a missing ID absent. A retry must not extend that horizon again.
    await client.query(`UPDATE cloud_v2_workspaces SET state='deleting',worker_token_hash=NULL,
      next_attempt_at=CASE WHEN boat_sandbox_id IS NULL AND next_attempt_at IS NOT NULL
        THEN greatest(next_attempt_at,clock_timestamp()+interval '5 minutes') ELSE NULL END,
      access_epoch=access_epoch+1,updated_at=clock_timestamp()
      WHERE state NOT IN ('deleting','deleted')`);
    await client.query("UPDATE cloud_v2_workspaces SET worker_token_hash=NULL WHERE worker_token_hash IS NOT NULL");
    await client.query("DELETE FROM cloud_v2_tokens");
    return {
      // A checkpoint retry's fork is a second VM; read through to_jsonb so a
      // database from before the column existed still drains.
      workspaces: (await client.query(`SELECT id,state,boat_sandbox_id,next_attempt_at,to_jsonb(w)->'checkpoint_retry_fork' AS retry_fork
        FROM cloud_v2_workspaces w ORDER BY id`)).rows,
      builds: (await client.query("SELECT id,org_id,version,builder_sandbox_id,builder_create_pending,snapshot_id,operation_until FROM cloud_v2_computer_builds ORDER BY id")).rows,
    };
  });
  let inventory;
  const sandbox = async (id, name) => {
    if (!id) {
      inventory ??= completeSandboxInventory(provider);
      const found = (await inventory).filter(row => row.name === name);
      if (found.length > 1) throw new Error("Ambiguous local sandbox ownership");
      id = found[0]?.id;
      if (!id) return { confirmed: true, id: null };
    }
    if (!SANDBOX_ID.test(id)) return { confirmed: false, id };
    return { id, confirmed: await deleteAndConfirm(provider, `/sandboxes/${id}`, id,
      value => value?.sandbox?.id === id && value.sandbox.name === name) };
  };

  for (const row of workspaces) {
    const key = `workspace:${row.id}`;
    try {
      if (!row.boat_sandbox_id && row.next_attempt_at && row.next_attempt_at.getTime() > Date.now()) { pending.add(key); continue; }
      const fork = row.retry_fork;
      if (fork) {
        // Boat names a fork after its source: this workspace's VM or one of its replacements.
        if (typeof fork.name !== "string" || !fork.name.startsWith(sandboxName("ws", row.id)) || !fork.name.endsWith(" fork")) { pending.add(key); continue; }
        const removed = await sandbox(typeof fork.sandboxId === "string" ? fork.sandboxId : null, fork.name);
        if (!removed.confirmed) { pending.add(key); continue; }
        await tx(client => client.query("UPDATE cloud_v2_workspaces SET checkpoint_retry_fork=NULL WHERE id=$1 AND checkpoint_retry_fork->>'attempt'=$2",
          [row.id, fork.attempt]));
      }
      const result = await sandbox(row.boat_sandbox_id, sandboxName("ws", row.id));
      if (!result.confirmed) { pending.add(key); continue; }
      await tx(client => client.query(`UPDATE cloud_v2_workspaces SET state='deleted',boat_sandbox_id=coalesce($2,boat_sandbox_id),
        next_attempt_at=NULL,updated_at=clock_timestamp() WHERE id=$1`, [row.id, result.id]));
    } catch { pending.add(key); }
  }

  for (const row of builds) {
    const key = `build:${row.id}`;
    try {
      // Snapshot/create calls already dispatched can outlive the backend.
      // Do not delete a snapshot while the provider can still publish it.
      if (row.operation_until && row.operation_until.getTime() > Date.now()) { pending.add(key); continue; }
      const result = row.builder_sandbox_id || row.builder_create_pending
        ? await sandbox(row.builder_sandbox_id, sandboxName("build", row.id)) : { confirmed: true, id: null };
      if (!result.confirmed) { pending.add(key); continue; }
      await tx(client => client.query(`UPDATE cloud_v2_computer_builds SET builder_sandbox_id=coalesce($2,builder_sandbox_id),
        builder_deleted_at=coalesce(builder_deleted_at,clock_timestamp()),builder_create_pending=false WHERE id=$1`, [row.id, result.id]));
      const name = snapshotName(row.org_id, row.version);
      if ((row.snapshot_id && row.snapshot_id !== name) ||
          !await deleteAndConfirm(provider, `/named-snapshots/${name}`, name)) { pending.add(key); continue; }
      await tx(async client => {
        await client.query(`UPDATE cloud_v2_computer_builds SET snapshot_id=NULL,snapshot_deleted_at=coalesce(snapshot_deleted_at,clock_timestamp()),
          operation_until=NULL WHERE id=$1`, [row.id]);
        await client.query(`UPDATE cloud_v2_computers SET active_build_id=NULL,snapshot_name=NULL,updated_at=clock_timestamp()
          WHERE org_id=$1 AND (active_build_id=$2 OR active_build_id IS NULL) AND (snapshot_name=$3 OR snapshot_name IS NULL)`, [row.org_id, row.id, name]);
      });
    } catch { pending.add(key); }
  }

  // An unbacked/foreign active snapshot pointer must keep reset incomplete;
  // never discard it merely because every build row has been processed.
  const unfinished = await tx(async client => (await client.query(`
    SELECT 'workspace:'||id::text AS key FROM cloud_v2_workspaces w WHERE state<>'deleted' OR to_jsonb(w)->'checkpoint_retry_fork' <> 'null'::jsonb
    UNION SELECT 'build:'||id::text FROM cloud_v2_computer_builds
      WHERE builder_create_pending OR builder_deleted_at IS NULL OR snapshot_deleted_at IS NULL OR snapshot_id IS NOT NULL OR operation_until IS NOT NULL
    UNION SELECT CASE WHEN active_build_id IS NULL THEN 'computer:'||org_id::text ELSE 'build:'||active_build_id::text END
      FROM cloud_v2_computers WHERE active_build_id IS NOT NULL OR snapshot_name IS NOT NULL`)).rows);
  for (const row of unfinished) pending.add(row.key);
  return { complete: pending.size === 0, pending: pending.size };
}
