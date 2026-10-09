import { describe, expect, it } from "vitest";
import type { Db } from "../../apps/control-plane/src/db";
import { createPostgresCostSampler } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/postgres-cost";

const epoch = "2026-10-08 10:00:00+00";
type Database = { xact_commit: string; xact_rollback: string; tup_inserted: string; tup_updated: string; tup_deleted: string; stats_reset: string | null };
type Statement = { userid: string; dbid: string; queryid: string; toplevel: boolean; calls: string; rows: string; stats_since: string };
type Snapshot = { database: Database; statements: Statement[]; dealloc: string; statementsReset: string; serverStarted: string;
  statementsAvailable: boolean; targetOid: string; backends: string; trackCounts: string; monitor: string };
function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { database: { xact_commit: "100", xact_rollback: "3", tup_inserted: "200", tup_updated: "40", tup_deleted: "20", stats_reset: epoch },
    statements: [{ userid: "10", dbid: "1234", queryid: "-123", toplevel: true, calls: "100", rows: "230", stats_since: epoch }],
    dealloc: "0", statementsReset: epoch, serverStarted: epoch, statementsAvailable: true,
    targetOid: "1234", backends: "0", trackCounts: "on", monitor: "test_w6_monitor", ...overrides };
}
function monitor(snapshots: Snapshot[], backendCounts?: string[]) {
  let position = 0, releases = 0;
  const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const pool = { connect: async () => ({
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      const current = snapshots[Math.min(position, snapshots.length - 1)]!;
      if (sql.includes("current_database()")) return { rows: [{ monitor_database: current.monitor, track_counts: current.trackCounts,
        server_started: current.serverStarted, target_oid: current.targetOid }] };
      if (sql.includes("pg_stat_clear_snapshot")) return { rows: [{}] };
      if (sql.includes("pg_stat_activity")) return { rows: [{ backend_count: backendCounts?.shift() ?? current.backends }] };
      if (sql.includes("pg_stat_database")) return { rows: [current.database] };
      if (sql.includes("to_regprocedure")) return { rows: [{ statements_available: current.statementsAvailable }] };
      if (sql.includes("pg_stat_statements_info")) return { rows: [{ dealloc: current.dealloc, stats_reset: current.statementsReset }] };
      if (sql.includes("pg_stat_statements(false)")) return { rows: current.statements };
      throw new Error("fixture_unrecognized_statistics_query");
    },
    release: () => { releases++; position++; },
  }) } as unknown as Db;
  return { pool, queries, releases: () => releases };
}
const advanced = (overrides: Partial<Snapshot> = {}) => snapshot({
  database: { xact_commit: "107", xact_rollback: "4", tup_inserted: "205", tup_updated: "43", tup_deleted: "22", stats_reset: epoch },
  statements: [{ userid: "10", dbid: "1234", queryid: "-123", toplevel: true, calls: "111", rows: "245", stats_since: epoch }], ...overrides,
});

describe("fixture PostgreSQL authoritative aggregate statistics", () => {
  it("defaults to unavailable statement counts without probing an unpreloaded module", async () => {
    const port = monitor([snapshot(), advanced()]);
    const sampler = createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6" });
    expect(sampler.window(await sampler.checkpoint(), await sampler.checkpoint())).toMatchObject({ databaseComplete: true,
      statementsComplete: false, statementUnavailableReason: "not-enabled", successfulStatementCalls: null });
    expect(port.queries.some(row => row.sql.includes("pg_stat_statements"))).toBe(false);
  });

  it("refuses another owner's monitoring database rather than silently using a shared DB", async () => {
    const port = monitor([snapshot({ monitor: "test_w4_monitor" })]);
    const sampler = createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6" });
    await expect(sampler.checkpoint()).rejects.toThrow("postgres_cost_monitor_not_separate");
  });

  it("refuses a producer crossing the sample instead of waiting and certifying old counters", async () => {
    const port = monitor([snapshot()], ["0", "1", "0"]);
    const sampler = createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6" });
    await expect(sampler.checkpoint()).rejects.toThrow("postgres_cost_target_changed_during_sample");
  });

  it("separates database transactions/write tuples from successful calls and retrieved-or-affected rows", async () => {
    const port = monitor([snapshot(), advanced()]);
    const sampler = createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6", statementStatistics: "optional" });
    const start = await sampler.checkpoint(), end = await sampler.checkpoint();
    expect(sampler.window(start, end)).toMatchObject({ authority: "postgresql-statistics", scope: "isolated-database-window",
      includesBackground: true, includesTeardown: true, databaseComplete: true, statementsComplete: true,
      database: { xactCommit: "7", xactRollback: "1", tuplesInserted: "5", tuplesUpdated: "3", tuplesDeleted: "2" },
      successfulStatementCalls: "11", statementRowsRetrievedOrAffected: "15", sqlWriteStatements: null, encodedPersistedBytes: null });
    expect(port.releases()).toBe(2);
    expect(Object.isFrozen(start)).toBe(true);
    expect(Object.isFrozen(start.database)).toBe(true);
  });

  it("reads only target database scalars from another DB, never query text or a global reset", async () => {
    const port = monitor([snapshot()]);
    await createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6", statementStatistics: "optional" }).checkpoint();
    const sql = port.queries.map(row => row.sql).join("\n");
    expect(sql).toContain("pg_stat_clear_snapshot()");
    expect(sql).toContain("pg_stat_statements(false)");
    expect(sql).not.toMatch(/pg_stat_(?:statements_)?reset|(?:SELECT|,)\s*query(?:\s|,)/i);
    for (const row of port.queries.filter(row => /pg_stat_activity|pg_stat_database|pg_stat_statements\(false\)/.test(row.sql)))
      expect(row.values?.[0]).toBe("1234");
  });

  it("keeps statements unavailable when the optional extension is absent without hiding database work", async () => {
    const port = monitor([snapshot({ statementsAvailable: false }), advanced({ statementsAvailable: false })]);
    const sampler = createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6", statementStatistics: "optional" });
    expect(sampler.window(await sampler.checkpoint(), await sampler.checkpoint())).toMatchObject({ databaseComplete: true,
      database: { tuplesInserted: "5", xactRollback: "1" }, statementsComplete: false,
      statementUnavailableReason: "extension-unavailable", successfulStatementCalls: null, statementRowsRetrievedOrAffected: null });
    expect(port.queries.some(row => row.sql.includes("pg_stat_statements(false)"))).toBe(false);
  });

  it.each(["xact_commit", "xact_rollback", "tup_inserted", "tup_updated", "tup_deleted"] as const)(
    "refuses a negative %s delta rather than reporting zero", async field => {
      const initial = snapshot(), changed = advanced();
      changed.database[field] = "0";
      const port = monitor([initial, changed]), sampler = createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6", statementStatistics: "optional" });
      expect(() => sampler.window(initial as never, changed as never)).toThrow("postgres_cost_checkpoint_invalid");
      const start = await sampler.checkpoint(), end = await sampler.checkpoint();
      expect(() => sampler.window(start, end)).toThrow("postgres_cost_counter_regressed");
    });

  it.each(["reset", "restart", "database-recreated"])("refuses %s across the sampled window", async kind => {
    const changed = advanced();
    if (kind === "reset") changed.database.stats_reset = "2026-10-08 11:00:00+00";
    if (kind === "restart") changed.serverStarted = "2026-10-08 11:00:00+00";
    if (kind === "database-recreated") changed.targetOid = "4321";
    const port = monitor([snapshot(), changed]), sampler = createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6", statementStatistics: "optional" });
    const start = await sampler.checkpoint(), end = await sampler.checkpoint();
    expect(() => sampler.window(start, end)).toThrow("postgres_cost_epoch_changed");
  });

  it.each(["reset", "deallocation", "entry-reset", "entry-missing", "call-regression", "row-regression"])(
    "retains DB work but refuses statement totals after %s", async kind => {
      const changed = advanced();
      if (kind === "reset") changed.statementsReset = "2026-10-08 11:00:00+00";
      if (kind === "deallocation") changed.dealloc = "1";
      if (kind === "entry-reset") changed.statements[0]!.stats_since = "2026-10-08 11:00:00+00";
      if (kind === "entry-missing") changed.statements = [];
      if (kind === "call-regression") changed.statements[0]!.calls = "1";
      if (kind === "row-regression") changed.statements[0]!.rows = "1";
      const port = monitor([snapshot(), changed]), sampler = createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6", statementStatistics: "optional" });
      expect(sampler.window(await sampler.checkpoint(), await sampler.checkpoint())).toMatchObject({ databaseComplete: true,
        statementsComplete: false, successfulStatementCalls: null, statementRowsRetrievedOrAffected: null });
    });

  it("accounts for new statement entries instead of requiring unchanged entry count", async () => {
    const changed = advanced();
    changed.statements.push({ userid: "10", dbid: "1234", queryid: "321", toplevel: true, calls: "2", rows: "9", stats_since: epoch });
    const port = monitor([snapshot(), changed]), sampler = createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6", statementStatistics: "optional" });
    expect(sampler.window(await sampler.checkpoint(), await sampler.checkpoint())).toMatchObject({ statementsComplete: true,
      successfulStatementCalls: "13", statementRowsRetrievedOrAffected: "24" });
  });

  it("preserves bigint precision without integer coercion or wrapping", async () => {
    const initial = snapshot(), changed = advanced();
    initial.database.xact_commit = "900719925474099300000";
    changed.database.xact_commit = "900719925474099300007";
    const port = monitor([initial, changed]), sampler = createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6", statementStatistics: "optional" });
    expect(sampler.window(await sampler.checkpoint(), await sampler.checkpoint()).database.xactCommit).toBe("7");
  });

  it.each(["same-db", "counts-off", "not-drained", "bad-counter"])("refuses unavailable snapshot %s without false zero", async kind => {
    const current = snapshot();
    if (kind === "same-db") current.monitor = "test_w6";
    if (kind === "counts-off") current.trackCounts = "off";
    if (kind === "not-drained") current.backends = "1";
    if (kind === "bad-counter") current.database.tup_inserted = "not-a-counter";
    const port = monitor([current]), sampler = createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6", statementStatistics: "optional", drainTimeoutMs: 0 });
    await expect(sampler.checkpoint()).rejects.toThrow(/^postgres_cost_/);
    expect(port.releases()).toBe(1);
  });

  it("refuses bounded-entry overflow instead of summing a partial statement sample", async () => {
    const current = snapshot();
    current.statements.push({ ...current.statements[0]!, queryid: "2" });
    const port = monitor([current, current]), sampler = createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6", statementStatistics: "optional", statementEntryLimit: 1 });
    expect(sampler.window(await sampler.checkpoint(), await sampler.checkpoint())).toMatchObject({ statementsComplete: false,
      statementUnavailableReason: "entry-cap", successfulStatementCalls: null });
  });

  it("refuses foreign, cloned and reversed owned checkpoints", async () => {
    const port = monitor([snapshot(), advanced()]), sampler = createPostgresCostSampler({ monitorPool: port.pool, targetDatabase: "test_w6", statementStatistics: "optional" });
    const other = createPostgresCostSampler({ monitorPool: monitor([snapshot()]).pool, targetDatabase: "test_w6", statementStatistics: "optional" });
    const start = await sampler.checkpoint(), end = await sampler.checkpoint(), foreign = await other.checkpoint();
    for (const bad of [foreign, structuredClone(start)]) expect(() => sampler.window(bad, end)).toThrow("postgres_cost_checkpoint_invalid");
    expect(() => sampler.window(end, start)).toThrow("postgres_cost_checkpoint_invalid");
  });
});
