// Moving retention's clocks live: only this run's own workspaces, by moving every retention timestamp of the row and of
// its wake records into the past, in one transaction read back before commit, through the stage's temporary role.
import { RehearsalFailure, type Database, type RehearsalState } from "./contract.js";
import { prefixed } from "./guard.js";

/** The workspace timestamps retention reads, the same list as the retention suite's travel(). A column the deployed
 * schema does not have yet (S4's missed_wake_alerted_at before #1246 ships) is left out, not invented. */
export const SHIFTED_COLUMNS = ["stopped_at", "machine_stopped_at", "active_at", "person_activity_at", "retention_started_at", "archived_at",
  "archive_wake_done_at", "backup_forked_at", "checkpoint_saved_at", "checkpoint_retry_at", "keep_set_at", "archive_scrubbed_at",
  "missed_wake_alerted_at"] as const;
export const MAX_SHIFTED_WORKSPACES = 4;

export async function shiftClock(database: Database, state: RehearsalState, workspaceIds: readonly string[], days: number):
  Promise<{ workspaces: number; wakes: number }> {
  if (!(days > 0 && days <= 90)) throw new RehearsalFailure("shift", "invalid_days");
  if (!workspaceIds.length || workspaceIds.length > MAX_SHIFTED_WORKSPACES || new Set(workspaceIds).size !== workspaceIds.length)
    throw new RehearsalFailure("shift", "too_many");
  if (workspaceIds.some(id => !state.created.workspaces.includes(id))) throw new RehearsalFailure("shift", "not_this_run");
  const result = await database.transaction(async query => {
    // The rows must be this run's: named with its prefix, in an organization it may touch, not deleted.
    const rows = (await query(`SELECT id::text AS id, name, org_id::text AS org_id FROM cloud_v2_workspaces
      WHERE id = ANY($1::uuid[]) AND state <> 'deleted' FOR UPDATE`, [workspaceIds])).rows;
    if (rows.length !== workspaceIds.length || rows.some(row => !prefixed(state.prefix, String(row.name)) || !state.organizations.includes(String(row.org_id))))
      throw new RehearsalFailure("shift", "refused");
    const present = new Set((await query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'cloud_v2_workspaces' AND column_name = ANY($1::text[])`, [[...SHIFTED_COLUMNS]]))
      .rows.map(row => String(row.column_name)));
    const columns = SHIFTED_COLUMNS.filter(column => present.has(column));
    if (!columns.includes("stopped_at")) throw new RehearsalFailure("shift", "schema");
    const before = await stamps(query, workspaceIds, columns);
    // Whole seconds: 10.6 days is not an exact float, and the read-back compares exact microseconds.
    const seconds = Math.round(days * 86_400);
    const set = columns.map(column => `${column} = ${column} - make_interval(secs => $2)`).join(", ");
    const shifted = await query(`UPDATE cloud_v2_workspaces SET ${set}, next_attempt_at = NULL WHERE id = ANY($1::uuid[])`, [workspaceIds, seconds]);
    const wakes = await query(`UPDATE cloud_v2_maintenance_wakes SET started_at = started_at - make_interval(secs => $2),
      finished_at = finished_at - make_interval(secs => $2) WHERE workspace_id = ANY($1::uuid[])`, [workspaceIds, seconds]);
    // Read back: every stamp that was set moved by exactly the shift; every null stayed null.
    const after = await stamps(query, workspaceIds, columns);
    const exact = shifted.rowCount === workspaceIds.length && [...before].every(([key, value]) =>
      value === null ? after.get(key) === null : after.get(key) === value - BigInt(seconds) * 1_000_000n);
    if (!exact) throw new RehearsalFailure("shift", "read_back");
    return { workspaces: shifted.rowCount, wakes: wakes.rowCount };
  }).catch(error => { throw error instanceof RehearsalFailure ? error : new RehearsalFailure("shift", "database"); });
  state.shifts++;
  return result;
}

async function stamps(query: Parameters<Parameters<Database["transaction"]>[0]>[0], ids: readonly string[], columns: readonly string[]) {
  // Microseconds as exact integers: a float comparison could refuse a correct shift.
  const select = columns.map(column => `((extract(epoch FROM ${column}) * 1000000)::bigint)::text AS ${column}`).join(", ");
  const rows = (await query(`SELECT id::text AS id, ${select} FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[])`, [ids])).rows;
  const out = new Map<string, bigint | null>();
  for (const row of rows) for (const column of columns) out.set(`${String(row.id)}:${column}`, row[column] === null ? null : BigInt(String(row[column])));
  return out;
}
