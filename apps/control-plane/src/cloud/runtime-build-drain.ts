import { SYSTEM_DATABASE_CONTEXT } from "../db-context.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx, type Tx } from "../db.js";

export const runtimeBuildDrainVersion = 1 as const;
const sha = z.string().regex(/^[a-f0-9]{40}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const binding = z.object({ runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/), liveCpSha: sha, priorRuntimeSha256: digest }).strict();
const leaseSchema = binding.extend({ version: z.literal(1), id: z.string().uuid().transform(value => value.toLowerCase()), expiresAt: z.string().datetime() }).strict();
export type BuildDrainBinding = z.infer<typeof binding>;
export type BuildDrainLease = z.infer<typeof leaseSchema>;
export type BuildDrainStatus = {
  version: 1; lease: BuildDrainLease; state: "active" | "expired" | "ended";
  liveCount: number; unresolvedCount: number; runtimeAdoptionCount: number; ready: boolean;
};
type Row = { version: number; lease_id: string | null; run_id: string | null; live_cp_sha: string | null;
  prior_runtime_sha256: string | null; ttl_ms: number | null; expires_at: Date | null; ended_at: Date | null };
export class BuildDrainError extends Error {
  constructor(readonly code: "runtime_build_drain_conflict" | "runtime_build_drain_mismatch" | "runtime_build_drain_unavailable") {
    super("Runtime build drain could not be confirmed.");
  }
}
const unavailable = () => new BuildDrainError("runtime_build_drain_unavailable");

// These operations retain the migration role. Runtime connections deliberately
// have no write privilege on the lease; a system RLS flag is not drain authority.
async function operatorTransaction<T>(pool: pg.Pool, action: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await pool.connect(); let lost = false;
  const onLost = () => { lost = true; }; tx.on("error", onLost); tx.on("end", onLost);
  try {
    await tx.query(`BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'; ${SYSTEM_DATABASE_CONTEXT}`);
    const value = await action(tx);
    if (lost) throw unavailable();
    await tx.query("COMMIT");
    if (lost) throw unavailable();
    return value;
  } catch (error) {
    if (!lost) await tx.query("ROLLBACK").catch(() => { lost = true; });
    if (lost) throw unavailable();
    throw error;
  } finally { tx.off("error", onLost); tx.off("end", onLost); tx.release(lost); }
}
async function locked(tx: Tx): Promise<Row> {
  const row = (await tx.query<Row>("SELECT * FROM cloud_runtime_build_drain WHERE singleton FOR UPDATE")).rows[0];
  if (!row || row.version !== runtimeBuildDrainVersion) throw unavailable();
  return row;
}
function lease(row: Row): BuildDrainLease {
  return leaseSchema.parse({ version: row.version, id: row.lease_id, runId: row.run_id, liveCpSha: row.live_cp_sha,
    priorRuntimeSha256: row.prior_runtime_sha256, expiresAt: row.expires_at?.toISOString() });
}
function exact(row: Row, value: BuildDrainLease): void {
  if (!row.lease_id || JSON.stringify(lease(row)) !== JSON.stringify(value)) throw new BuildDrainError("runtime_build_drain_mismatch");
}
async function status(tx: Tx, row: Row): Promise<BuildDrainStatus> {
  const counts = (await tx.query<{ live: number; unresolved: number; adoptions: number; active: boolean }>(`SELECT
    (SELECT count(*)::int FROM cloud_v2_computer_builds WHERE state='building') AS live,
    (SELECT count(*)::int FROM cloud_v2_computer_builds b WHERE b.state<>'building' AND
      (b.builder_create_pending OR (b.builder_sandbox_id IS NOT NULL AND b.builder_deleted_at IS NULL) OR b.operation_until IS NOT NULL
       OR (b.snapshot_id IS NOT NULL AND b.snapshot_deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM cloud_v2_computers c WHERE c.active_build_id=b.id)
         AND NOT EXISTS (SELECT 1 FROM cloud_v2_workspaces w WHERE w.computer_build_id=b.id AND w.org_id=b.org_id
           AND w.boat_sandbox_id IS NULL AND (w.state='creating' OR (w.restore_pending AND w.state<>'deleted')))))) AS unresolved,
    (SELECT count(*)::int FROM cloud_worker_runtime_handoffs h JOIN cloud_v2_workspaces w ON w.id=h.workspace_id
      WHERE h.state IN ('committed','activating','rolling_back') AND w.state='running'
        AND w.worker_token_hash=h.token_hash AND w.worker_boot_id=h.old_boot_id AND w.boat_sandbox_id=h.sandbox_id) AS adoptions,
    $1::timestamptz>clock_timestamp() AS active`, [row.expires_at])).rows[0];
  if (!counts) throw unavailable();
  const state = row.ended_at ? "ended" : counts.active ? "active" : "expired";
  return { version: 1, lease: lease(row), state, liveCount: counts.live, unresolvedCount: counts.unresolved,
    runtimeAdoptionCount: counts.adoptions, ready: state === "active" && counts.live === 0 && counts.unresolved === 0 && counts.adoptions === 0 };
}

export async function beginBuildDrain(pool: pg.Pool, input: BuildDrainBinding & { ttlMs: number }): Promise<BuildDrainStatus> {
  const value = binding.extend({ ttlMs: z.number().int().min(1000).max(900_000) }).strict().parse(input);
  return operatorTransaction(pool, async tx => {
    const old = await locked(tx);
    const previous = (await tx.query<Row>("SELECT * FROM cloud_runtime_build_drain_runs WHERE run_id=$1", [value.runId])).rows[0];
    if (previous) {
      if (previous.live_cp_sha !== value.liveCpSha || previous.prior_runtime_sha256 !== value.priorRuntimeSha256 || previous.ttl_ms !== value.ttlMs)
        throw new BuildDrainError("runtime_build_drain_mismatch");
      return status(tx, previous);
    }
    if (old.lease_id && (await status(tx, old)).state === "active") throw new BuildDrainError("runtime_build_drain_conflict");
    const next = (await tx.query<Row>(`UPDATE cloud_runtime_build_drain SET lease_id=$1,run_id=$2,live_cp_sha=$3,prior_runtime_sha256=$4,
      ttl_ms=$5::integer,expires_at=date_trunc('milliseconds',clock_timestamp())+$5::integer*interval '1 millisecond',ended_at=NULL
      WHERE singleton RETURNING *`, [randomUUID(), value.runId, value.liveCpSha, value.priorRuntimeSha256, value.ttlMs])).rows[0];
    if (!next) throw unavailable();
    await tx.query(`INSERT INTO cloud_runtime_build_drain_runs(run_id,lease_id,live_cp_sha,prior_runtime_sha256,ttl_ms,expires_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [next.run_id, next.lease_id, next.live_cp_sha, next.prior_runtime_sha256, next.ttl_ms, next.expires_at]);
    return status(tx, next);
  });
}
export async function inspectBuildDrain(pool: pg.Pool, input: BuildDrainLease): Promise<BuildDrainStatus> {
  const value = leaseSchema.parse(input);
  return operatorTransaction(pool, async tx => { const row = await locked(tx); exact(row, value); return status(tx, row); });
}
export async function endBuildDrain(pool: pg.Pool, input: BuildDrainLease): Promise<{ version: 1; lease: BuildDrainLease; released: true }> {
  const value = leaseSchema.parse(input);
  return operatorTransaction(pool, async tx => {
    const row = await locked(tx); exact(row, value);
    await tx.query("UPDATE cloud_runtime_build_drain SET ended_at=coalesce(ended_at,clock_timestamp()) WHERE singleton");
    await tx.query(`UPDATE cloud_runtime_build_drain_runs SET ended_at=(SELECT ended_at FROM cloud_runtime_build_drain WHERE singleton)
      WHERE run_id=$1 AND lease_id=$2`, [value.runId, value.id]);
    return { version: 1, lease: value, released: true };
  });
}
export async function buildDrainActive(pool: pg.Pool): Promise<boolean> {
  return withSystemTx(pool, async tx => {
    const row = (await tx.query<{ version: number; active: boolean }>("SELECT version,lease_id IS NOT NULL AND ended_at IS NULL AND expires_at>clock_timestamp() AS active FROM cloud_runtime_build_drain WHERE singleton")).rows[0];
    if (!row || row.version !== runtimeBuildDrainVersion) throw unavailable();
    return row.active;
  });
}

export async function buildClaimAllowed(tx: Tx): Promise<boolean> {
  const row = (await tx.query<{ allowed: boolean }>("SELECT cloud_runtime_build_claim_allowed() AS allowed")).rows[0];
  if (!row || typeof row.allowed !== "boolean") throw unavailable();
  return row.allowed;
}
