import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../apps/control-plane/src/db";
import { createPostgresCostSampler, type PostgresCostCheckpoint } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/postgres-cost";

type Backend = { backend_type: string; state: string | null };
const autovacuum: Backend = { backend_type: "autovacuum worker", state: "active" };

function monitor(backends: (statisticsReads: number) => Backend[]) {
  const statisticsReadAt: number[] = [];
  const release = vi.fn();
  const pool = { connect: async () => ({
    query: async (sql: string) => {
      if (sql.includes("current_database()")) return { rows: [{ monitor_database: "cost_monitor",
        track_counts: "on", server_started: "2026-10-10 00:00:00+00", target_oid: "1234" }] };
      if (sql.includes("pg_stat_clear_snapshot")) return { rows: [{}] };
      if (sql.includes("pg_stat_activity")) {
        const current = backends(statisticsReadAt.length);
        return { rows: [{ backend_count: String(current.length),
          non_client_backend_count: String(current.filter(backend => backend.backend_type !== "client backend").length) }] };
      }
      if (sql.includes("pg_stat_database")) {
        statisticsReadAt.push(performance.now());
        return { rows: [{ xact_commit: "125", xact_rollback: "0", tup_inserted: "12",
          tup_updated: "3", tup_deleted: "2", stats_reset: null }] };
      }
      throw new Error("unexpected_statistics_query");
    },
    release,
  }) } as unknown as Db;
  return { pool, statisticsReadAt, release };
}

function sampler(port: ReturnType<typeof monitor>) {
  return createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "cost_target",
    monitorDatabase: "cost_monitor", initialNonClientDrainTimeoutMs: 5_000 });
}

function settled(sample: Promise<PostgresCostCheckpoint>) {
  return sample.then(checkpoint => ({ checkpoint, completedAt: performance.now() }),
    (error: unknown) => ({ error: error instanceof Error ? error.message : "unexpected_error", completedAt: performance.now() }));
}

describe("initial PostgreSQL cost maintenance drain", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "performance"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("waits for an autovacuum worker beyond the client deadline before reading any counters", async () => {
    const port = monitor(() => performance.now() < 2_500 ? [autovacuum] : []);
    const result = settled(sampler(port).checkpoint());
    await vi.advanceTimersByTimeAsync(2_600);
    expect(await result).toMatchObject({ checkpoint: { drainProof: "target-backends-exited",
      database: { xactCommit: "125" } }, completedAt: 2_500 });
    expect(port.statisticsReadAt).toEqual([2_500]);
    expect(port.release).toHaveBeenCalledOnce();
  });

  it.each(["active", "idle", "idle in transaction"])("still refuses a real %s client within the original deadline", async state => {
    const port = monitor(() => [autovacuum, { backend_type: "client backend", state }]);
    const result = settled(sampler(port).checkpoint());
    await vi.advanceTimersByTimeAsync(2_100);
    expect(await result).toEqual({ error: "postgres_cost_target_not_drained", completedAt: 2_000 });
    expect(port.statisticsReadAt).toEqual([]);
  });

  it("bounds the initial maintenance wait and never samples a worker that remains attached", async () => {
    const port = monitor(() => [autovacuum]);
    const result = settled(sampler(port).checkpoint());
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await result).toEqual({ error: "postgres_cost_target_not_drained", completedAt: 5_000 });
    expect(port.statisticsReadAt).toEqual([]);
  });

  it("refuses a client joining the maintenance wait once the original client deadline has expired", async () => {
    const port = monitor(() => performance.now() < 2_500 ? [autovacuum] :
      [autovacuum, { backend_type: "client backend", state: "idle" }]);
    const result = settled(sampler(port).checkpoint());
    await vi.advanceTimersByTimeAsync(2_600);
    expect(await result).toEqual({ error: "postgres_cost_target_not_drained", completedAt: 2_500 });
    expect(port.statisticsReadAt).toEqual([]);
  });

  it("refuses an autovacuum worker entering during the sample without waiting or certifying counters", async () => {
    const port = monitor(reads => reads > 0 ? [autovacuum] : []);
    await expect(sampler(port).checkpoint()).rejects.toThrow("postgres_cost_target_changed_during_sample");
    expect(port.statisticsReadAt).toEqual([0]);
    expect(performance.now()).toBe(0);
  });

  it("keeps the original deadline for maintenance at every later checkpoint", async () => {
    // The first sample's final census is empty; only the next checkpoint is busy.
    let firstCompleted = false;
    const later = monitor(() => firstCompleted ? [autovacuum] : []);
    const samples = sampler(later);
    await samples.checkpoint();
    firstCompleted = true;
    const result = settled(samples.checkpoint());
    await vi.advanceTimersByTimeAsync(2_100);
    expect(await result).toEqual({ error: "postgres_cost_target_not_drained", completedAt: 2_000 });
    expect(later.statisticsReadAt).toEqual([0]);
  });
});
