import { z } from "zod";
import type { createMigrationPool } from "../../apps/control-plane/src/db";
import { beginBuildDrain, inspectBuildDrain, endBuildDrain, runtimeBuildDrainVersion,
  type BuildDrainLease, type BuildDrainStatus } from "../../apps/control-plane/src/cloud/runtime-build-drain";
import { PromotionError, requireCheck } from "./contracts";
import type { RuntimeReleaseConfig } from "./runtime-contracts";

export const RUNTIME_BUILD_DRAIN_TTL_MS = 900_000;
export const RUNTIME_STAGE_BUDGET_MS = 10 * 60_000;
export const RUNTIME_READINESS_BUDGET_MS = 8 * 60_000;
export const RUNTIME_CLEANUP_BUDGET_MS = 60_000;
export type RuntimeDrainLease = BuildDrainLease;
export type RuntimeDrainStatus = BuildDrainStatus;
export type RuntimeDrainEnd = Awaited<ReturnType<typeof endBuildDrain>>;
const Lease = z.object({
  version: z.literal(runtimeBuildDrainVersion), id: z.string().uuid().transform(value => value.toLowerCase()),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/), liveCpSha: z.string().regex(/^[a-f0-9]{40}$/),
  priorRuntimeSha256: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime(),
}).strict();
const Status = z.object({
  version: z.literal(runtimeBuildDrainVersion), lease: Lease, state: z.enum(["active", "expired", "ended"]),
  liveCount: z.number().int().nonnegative(), unresolvedCount: z.number().int().nonnegative(),
  runtimeAdoptionCount: z.number().int().nonnegative(), ready: z.boolean(),
}).strict();
const Released = z.object({ version: z.literal(runtimeBuildDrainVersion), lease: Lease, released: z.literal(true) }).strict();

export function boundRuntimeDrainLease(config: RuntimeReleaseConfig, value: unknown): RuntimeDrainLease {
  const parsed = Lease.safeParse(value);
  requireCheck(parsed.success && parsed.data.runId === config.runId && parsed.data.liveCpSha === config.expectedCpSha &&
    parsed.data.priorRuntimeSha256 === config.expectedRuntimeSha256, "Build drain lease is unavailable or belongs to another release");
  return parsed.data;
}
function sameLease(config: RuntimeReleaseConfig, expected: RuntimeDrainLease, value: unknown) {
  const actual = boundRuntimeDrainLease(config, value), bound = boundRuntimeDrainLease(config, expected);
  requireCheck(JSON.stringify(actual) === JSON.stringify(bound), "Build drain lease changed; no release mutation is authorized");
  return actual;
}
function readStatus(config: RuntimeReleaseConfig, value: unknown): RuntimeDrainStatus {
  const parsed = Status.safeParse(value);
  requireCheck(parsed.success, "Build drain status is unavailable or unsupported");
  const result = parsed.data;
  boundRuntimeDrainLease(config, result.lease);
  requireCheck(result.ready === (result.state === "active" && result.liveCount === 0 && result.unresolvedCount === 0 && result.runtimeAdoptionCount === 0),
    "Build drain readiness contradicts its state or activity counts");
  return result;
}
export function assertActiveRuntimeDrain(config: RuntimeReleaseConfig, lease: RuntimeDrainLease, value: unknown): RuntimeDrainStatus {
  const result = readStatus(config, value); sameLease(config, lease, result.lease);
  const remaining = Date.parse(result.lease.expiresAt) - Date.now();
  requireCheck(result.state === "active" && remaining > 60_000 && remaining <= RUNTIME_BUILD_DRAIN_TTL_MS + 30_000,
    "Build drain is ended, expired, or lacks time for a release mutation");
  return result;
}
export function assertEmptyRuntimeDrain(config: RuntimeReleaseConfig, lease: RuntimeDrainLease, value: unknown): void {
  requireCheck(assertActiveRuntimeDrain(config, lease, value).ready, "Build drain is not confirmed empty; no deploy is authorized");
}
export function assertRuntimeDrainBudget(config: RuntimeReleaseConfig, lease: RuntimeDrainLease, value: unknown, budgetMs: number): void {
  assertEmptyRuntimeDrain(config, lease, value);
  requireCheck(Date.parse(lease.expiresAt) - Date.now() >= budgetMs, "Build drain lacks the reserved release budget; no mutation is authorized");
}
export function assertRuntimeDrainRecovery(config: RuntimeReleaseConfig, lease: RuntimeDrainLease, value: unknown): void {
  const status = readStatus(config, value); sameLease(config, lease, status.lease);
  requireCheck(status.state === "active" && status.ready && Date.parse(lease.expiresAt) > Date.now(),
    "Runtime staged-pin recovery requires its active empty lease");
}
export function assertRuntimeDrainReleased(config: RuntimeReleaseConfig, lease: RuntimeDrainLease, value: unknown): RuntimeDrainEnd {
  const parsed = Released.safeParse(value);
  requireCheck(parsed.success, "Build drain release is unconfirmed");
  sameLease(config, lease, parsed.data.lease);
  return parsed.data;
}

const failureCodes = new Set(["runtime_build_drain_conflict", "runtime_build_drain_mismatch", "runtime_build_drain_unavailable"]);
async function operator<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (error) {
    if (error instanceof PromotionError) throw error;
    const code = (error as { code?: unknown })?.code;
    throw Object.assign(new PromotionError("Runtime build drain could not be confirmed; details withheld"),
      { code: typeof code === "string" && failureCodes.has(code) ? code : "runtime_build_drain_unavailable" });
  }
}

export function runtimeDrain(config: RuntimeReleaseConfig, migrationPool: ReturnType<typeof createMigrationPool>) {
  // A workflow rerun keeps its run ID; a new attempt must never renew a consumed drain.
  const input = { runId: config.runId, liveCpSha: config.expectedCpSha, priorRuntimeSha256: config.expectedRuntimeSha256, ttlMs: RUNTIME_BUILD_DRAIN_TTL_MS };
  return {
    beginDrain: () => operator(async () => readStatus(config, await beginBuildDrain(migrationPool, input))),
    inspectDrain: (lease: RuntimeDrainLease) => operator(async () => {
      const bound = boundRuntimeDrainLease(config, lease), result = readStatus(config, await inspectBuildDrain(migrationPool, bound));
      sameLease(config, bound, result.lease); return result;
    }),
    endDrain: (lease: RuntimeDrainLease) => operator(async () => {
      const bound = boundRuntimeDrainLease(config, lease);
      return assertRuntimeDrainReleased(config, bound, await endBuildDrain(migrationPool, bound));
    }),
  };
}

export async function existingRuntimeDrain(config: RuntimeReleaseConfig, migrationPool: ReturnType<typeof createMigrationPool>): Promise<RuntimeDrainStatus | null> {
  return operator(async () => {
    const tx = await migrationPool.connect();
    let lease: RuntimeDrainLease | null = null;
    try {
      await tx.query("BEGIN READ ONLY; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'; SELECT set_config('app.system','on',true)");
      const result = await tx.query<{ version: number; lease_id: string; run_id: string; live_cp_sha: string;
        prior_runtime_sha256: string; expires_at: Date; ttl_ms: number }>(
        "SELECT version,lease_id,run_id,live_cp_sha,prior_runtime_sha256,expires_at,ttl_ms FROM cloud_runtime_build_drain_runs WHERE run_id=$1", [config.runId]);
      if (result.rows.length) {
        const row = result.rows[0];
        requireCheck(result.rows.length === 1 && row.ttl_ms === RUNTIME_BUILD_DRAIN_TTL_MS, "Runtime cleanup drain binding differs");
        lease = boundRuntimeDrainLease(config, { version: row.version, id: row.lease_id, runId: row.run_id,
          liveCpSha: row.live_cp_sha, priorRuntimeSha256: row.prior_runtime_sha256, expiresAt: row.expires_at.toISOString() });
      }
      await tx.query("COMMIT");
    } catch (error) { await tx.query("ROLLBACK").catch(() => {}); throw error; }
    finally { tx.release(); }
    // Cleanup may recover an existing receipt, but must never create a missing lease.
    return lease ? runtimeDrain(config, migrationPool).inspectDrain(lease) : null;
  });
}
