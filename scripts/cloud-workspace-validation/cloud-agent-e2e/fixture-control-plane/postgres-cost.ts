import { randomUUID } from "node:crypto";
import type { Db, Tx } from "../../../../apps/control-plane/src/db";

// Explicit script-only sampler: an isolated target and a separate monitoring
// database are required. All producer connections must retire at each sample
// boundary. The aggregate includes background/teardown work; no idle subtraction
// or app-observer approximation can turn missing statistics into zero.
type DatabaseCounters = Readonly<{ xactCommit: string; xactRollback: string; tuplesInserted: string; tuplesUpdated: string; tuplesDeleted: string }>;
type StatementReason = "not-enabled" | "extension-unavailable" | "statistics-unavailable" | "entry-cap" | "epoch-changed" | "counter-regressed";
type StatementEntry = { calls: bigint; rows: bigint; since: string };
type Statements = { reason: null; entries: Map<string, StatementEntry>; dealloc: string; reset: string | null; calls: string; rows: string } |
  { reason: StatementReason };
export type PostgresCostCheckpoint = Readonly<{
  version: 1; clockDomainId: string; sampleStartedAtUs: number; sampleCompletedAtUs: number;
  drainProof: "target-backends-exited"; database: DatabaseCounters;
  successfulStatementCalls: string | null; statementRowsRetrievedOrAffected: string | null;
  statementUnavailableReason: StatementReason | null;
}>;
export type PostgresCostWindow = Readonly<{
  version: 1; authority: "postgresql-statistics"; scope: "isolated-database-window";
  includesBackground: true; includesTeardown: true; clockDomainId: string;
  startSampleCompletedAtUs: number; endSampleCompletedAtUs: number; databaseComplete: true;
  database: DatabaseCounters; statementsComplete: boolean; statementUnavailableReason: StatementReason | null;
  successfulStatementCalls: string | null; statementRowsRetrievedOrAffected: string | null;
  sqlWriteStatements: null; encodedPersistedBytes: null;
}>;
type PrivateCheckpoint = { ordinal: number; targetOid: string; serverStarted: string; reset: string | null; statements: Statements };
class StatisticsRefusal extends Error {
  constructor(code: string) { super(code); }
}
const refuse = (code: string): never => { throw new StatisticsRefusal(code); };
function field(row: unknown, key: string): unknown {
  if (!row || typeof row !== "object") return undefined;
  return Object.getOwnPropertyDescriptor(row, key)?.value;
}
function counter(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,63})$/.test(value)) return refuse("postgres_cost_statistics_unavailable");
  return value;
}
function stamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > 128 || !Number.isFinite(Date.parse(value))) return refuse("postgres_cost_statistics_unavailable");
  return value;
}
function one(rows: unknown[]): unknown {
  if (rows.length !== 1) return refuse("postgres_cost_statistics_unavailable");
  return rows[0];
}
const columns = { xactCommit: "xact_commit", xactRollback: "xact_rollback", tuplesInserted: "tup_inserted",
  tuplesUpdated: "tup_updated", tuplesDeleted: "tup_deleted" } as const;
function databaseCounters(row: unknown): DatabaseCounters {
  return Object.freeze(Object.fromEntries(Object.entries(columns).map(([key, column]) => [key, counter(field(row, column))])) as DatabaseCounters);
}
function nowUs(): number {
  const value = Number(process.hrtime.bigint() / 1000n);
  if (!Number.isSafeInteger(value) || value <= 0) return refuse("postgres_cost_clock_unavailable");
  return value;
}

class PostgresCostSampler {
  private readonly clockDomainId = randomUUID();
  private readonly checkpoints = new WeakMap<PostgresCostCheckpoint, PrivateCheckpoint>();
  private ordinal = 0;
  private sampling = false;
  private readonly drainTimeoutMs: number;
  private readonly statementEntryLimit: number;
  constructor(private readonly options: { monitorPool: Db; targetDatabase: string; drainTimeoutMs?: number; statementEntryLimit?: number;
    statementStatistics?: "optional" | "unavailable" }) {
    if (!/^test_[a-z0-9_]{1,58}$/.test(options.targetDatabase)) refuse("postgres_cost_target_invalid");
    this.drainTimeoutMs = options.drainTimeoutMs ?? 2000;
    this.statementEntryLimit = options.statementEntryLimit ?? 8192;
    if (!Number.isSafeInteger(this.drainTimeoutMs) || this.drainTimeoutMs < 0 || this.drainTimeoutMs > 5000 ||
        !Number.isSafeInteger(this.statementEntryLimit) || this.statementEntryLimit < 1 || this.statementEntryLimit > 8192)
      refuse("postgres_cost_options_invalid");
  }
  private async drained(client: Tx, targetOid: string, final = false): Promise<void> {
    const deadline = performance.now() + this.drainTimeoutMs;
    for (;;) {
      // Clears this monitor session's cache only; it never resets counters.
      await client.query("SELECT pg_stat_clear_snapshot()");
      const row = one((await client.query("SELECT count(*)::text AS backend_count FROM pg_stat_activity WHERE datid=$1::oid", [targetOid])).rows);
      if (counter(field(row, "backend_count")) === "0") return;
      if (final) refuse("postgres_cost_target_changed_during_sample");
      if (performance.now() >= deadline) refuse("postgres_cost_target_not_drained");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  private async statements(client: Tx, targetOid: string): Promise<Statements> {
    // The shared local PostgreSQL instance has no preloaded module and must
    // not restart for measurement. Optional module support is explicit; the
    // current harness never probes or reads it and never reports false zero.
    if (this.options.statementStatistics !== "optional") return { reason: "not-enabled" };
    try {
      const available = one((await client.query("SELECT to_regprocedure('public.pg_stat_statements(boolean)') IS NOT NULL AS statements_available")).rows);
      if (field(available, "statements_available") !== true) return { reason: "extension-unavailable" };
      const infoSql = "SELECT dealloc::text, stats_reset::text FROM public.pg_stat_statements_info";
      const first = one((await client.query(infoSql)).rows), dealloc = counter(field(first, "dealloc")), reset = stamp(field(first, "stats_reset"), true);
      // showtext=false plus an explicit scalar projection: query text is never
      // selected, transferred, retained or used to classify statement cost.
      const rows = (await client.query(`SELECT userid::text, dbid::text, queryid::text, toplevel, calls::text, rows::text, stats_since::text
        FROM public.pg_stat_statements(false) WHERE dbid=$1::oid LIMIT $2`, [targetOid, this.statementEntryLimit + 1])).rows;
      if (rows.length > this.statementEntryLimit) return { reason: "entry-cap" };
      const entries = new Map<string, StatementEntry>();
      let calls = 0n, retrievedRows = 0n;
      for (const row of rows) {
        const user = counter(field(row, "userid")), db = counter(field(row, "dbid")), queryId = field(row, "queryid"), top = field(row, "toplevel");
        if (db !== targetOid || typeof queryId !== "string" || !/^-?[0-9]{1,20}$/.test(queryId) || typeof top !== "boolean")
          return { reason: "statistics-unavailable" };
        const key = `${user}:${db}:${queryId}:${top}`;
        if (entries.has(key)) return { reason: "statistics-unavailable" };
        const entry = { calls: BigInt(counter(field(row, "calls"))), rows: BigInt(counter(field(row, "rows"))), since: stamp(field(row, "stats_since"))! };
        entries.set(key, entry); calls += entry.calls; retrievedRows += entry.rows;
      }
      const last = one((await client.query(infoSql)).rows);
      if (dealloc !== counter(field(last, "dealloc")) || reset !== stamp(field(last, "stats_reset"), true)) return { reason: "epoch-changed" };
      return { reason: null, entries, dealloc, reset, calls: calls.toString(), rows: retrievedRows.toString() };
    } catch { return { reason: "statistics-unavailable" }; }
  }
  async checkpoint(): Promise<PostgresCostCheckpoint> {
    if (this.sampling) return refuse("postgres_cost_sample_busy");
    this.sampling = true;
    let client: Tx | undefined;
    try {
      const sampleStartedAtUs = nowUs();
      client = await this.options.monitorPool.connect();
      const context = one((await client.query(`SELECT current_database() AS monitor_database, current_setting('track_counts') AS track_counts,
        pg_postmaster_start_time()::text AS server_started, (SELECT oid::text FROM pg_database WHERE datname=$1) AS target_oid`, [this.options.targetDatabase])).rows);
      const monitorDatabase = field(context, "monitor_database"), targetOid = counter(field(context, "target_oid"));
      if (monitorDatabase !== `${this.options.targetDatabase}_monitor`) refuse("postgres_cost_monitor_not_separate");
      if (targetOid === "0" || BigInt(targetOid) > 4294967295n) refuse("postgres_cost_target_invalid");
      if (field(context, "track_counts") !== "on") refuse("postgres_cost_tracking_disabled");
      const serverStarted = stamp(field(context, "server_started"))!;
      await this.drained(client, targetOid);
      await client.query("SELECT pg_stat_clear_snapshot()");
      const row = one((await client.query(`SELECT xact_commit::text, xact_rollback::text, tup_inserted::text, tup_updated::text,
        tup_deleted::text, stats_reset::text FROM pg_stat_database WHERE datid=$1::oid`, [targetOid])).rows);
      const database = databaseCounters(row), reset = stamp(field(row, "stats_reset"), true);
      const statements = await this.statements(client, targetOid);
      // Recheck drain after the sample, not just before it. Active/pending
      // producer statistics cannot be certified by an elapsed idle timeout.
      await this.drained(client, targetOid, true);
      const checkpoint: PostgresCostCheckpoint = Object.freeze({ version: 1, clockDomainId: this.clockDomainId,
        sampleStartedAtUs, sampleCompletedAtUs: nowUs(), drainProof: "target-backends-exited", database,
        successfulStatementCalls: statements.reason ? null : statements.calls,
        statementRowsRetrievedOrAffected: statements.reason ? null : statements.rows,
        statementUnavailableReason: statements.reason });
      this.checkpoints.set(checkpoint, { ordinal: ++this.ordinal, targetOid, serverStarted, reset, statements });
      return checkpoint;
    } catch (error) {
      if (error instanceof StatisticsRefusal) throw error;
      return refuse("postgres_cost_statistics_unavailable");
    } finally {
      this.sampling = false;
      try { client?.release(); } catch { refuse("postgres_cost_statistics_unavailable"); }
    }
  }
  window(start: PostgresCostCheckpoint, end: PostgresCostCheckpoint): PostgresCostWindow {
    const first = this.checkpoints.get(start), last = this.checkpoints.get(end);
    if (!first || !last || first.ordinal > last.ordinal || start.sampleCompletedAtUs > end.sampleCompletedAtUs)
      return refuse("postgres_cost_checkpoint_invalid");
    if (first.targetOid !== last.targetOid || first.serverStarted !== last.serverStarted || first.reset !== last.reset)
      return refuse("postgres_cost_epoch_changed");
    const database = Object.freeze(Object.fromEntries((Object.keys(columns) as Array<keyof DatabaseCounters>).map(key => {
      const delta = BigInt(end.database[key]) - BigInt(start.database[key]);
      if (delta < 0n) refuse("postgres_cost_counter_regressed");
      return [key, delta.toString()];
    })) as DatabaseCounters);
    const before = first.statements, after = last.statements;
    let reason = before.reason ?? after.reason, calls = 0n, rows = 0n;
    if (!before.reason && !after.reason) {
      if (before.dealloc !== after.dealloc || before.reset !== after.reset) reason = "epoch-changed";
      for (const [key, entry] of before.entries) {
        const next = after.entries.get(key);
        if (!next || entry.since !== next.since) reason = "epoch-changed";
      }
      for (const [key, entry] of after.entries) {
        const previous = before.entries.get(key), callDelta = entry.calls - (previous?.calls ?? 0n), rowDelta = entry.rows - (previous?.rows ?? 0n);
        if (callDelta < 0n || rowDelta < 0n) reason = "counter-regressed";
        calls += callDelta; rows += rowDelta;
      }
    }
    return Object.freeze({ version: 1, authority: "postgresql-statistics", scope: "isolated-database-window",
      includesBackground: true, includesTeardown: true, clockDomainId: this.clockDomainId,
      startSampleCompletedAtUs: start.sampleCompletedAtUs, endSampleCompletedAtUs: end.sampleCompletedAtUs,
      databaseComplete: true, database, statementsComplete: !reason, statementUnavailableReason: reason,
      successfulStatementCalls: reason ? null : calls.toString(), statementRowsRetrievedOrAffected: reason ? null : rows.toString(),
      sqlWriteStatements: null, encodedPersistedBytes: null });
  }
}
export function createPostgresCostSampler(options: ConstructorParameters<typeof PostgresCostSampler>[0]) { return new PostgresCostSampler(options); }
