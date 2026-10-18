// Server-side cross-checks for the load simulator. Both sources are optional:
// pg_stat_database is always present, pg_stat_statements only when the server
// preloads it. Neither is used for budgets; the client-side meter is exact.

import type pg from "pg";

export const STATS_SCHEMA = "load_sim";

export type StatementSample = {
  query: string;
  calls: number;
  totalExecMs: number;
  meanExecMs: number;
  rows: number;
};

export type ServerWindow = {
  /** xact_commit + xact_rollback for this database, minus this probe's own. */
  transactions: number;
  /** Top-level statement execution time recorded by pg_stat_statements. */
  execMs: number | null;
  statementCalls: number | null;
  top: StatementSample[];
};

export class ServerStats {
  private constructor(private readonly pool: pg.Pool, readonly statements: boolean) {}

  /** Creates pg_stat_statements in its own schema when the server preloads it. */
  static async open(pool: pg.Pool, options: { installStatements: boolean }): Promise<ServerStats> {
    let statements = false;
    if (options.installStatements) {
      const preloaded = (await pool.query<{ setting: string }>("SELECT setting FROM pg_settings WHERE name='shared_preload_libraries'")).rows[0]?.setting ?? "";
      if (preloaded.split(",").map(value => value.trim()).includes("pg_stat_statements")) {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${STATS_SCHEMA}`);
        await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements SCHEMA ${STATS_SCHEMA}`);
        statements = true;
      }
    }
    return new ServerStats(pool, statements);
  }

  private async transactions(): Promise<number> {
    // Cumulative statistics are flushed by each backend at most once a second.
    const row = (await this.pool.query<{ total: string }>(
      "SELECT (xact_commit + xact_rollback)::text AS total FROM pg_stat_database WHERE datname=current_database()")).rows[0];
    return Number(row?.total ?? 0);
  }

  async begin(): Promise<() => Promise<ServerWindow>> {
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await this.pool.query("SELECT pg_stat_clear_snapshot()");
    const before = await this.transactions();
    if (this.statements) await this.pool.query(`SELECT ${STATS_SCHEMA}.pg_stat_statements_reset()`);
    return async () => {
      await new Promise(resolve => setTimeout(resolve, 1_100));
      await this.pool.query("SELECT pg_stat_clear_snapshot()");
      // The probe's own commits inside the window: the opening counter read,
      // the statements reset and the closing snapshot clear. Unflushed counts
      // from before the window can still land in it, so this is approximate.
      const after = await this.transactions();
      const probe = this.statements ? 3 : 2;
      if (!this.statements) return { transactions: after - before - probe, execMs: null, statementCalls: null, top: [] };
      const filter = `dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND toplevel
        AND query NOT ILIKE '%pg_stat_statements%' AND query NOT ILIKE '%pg_stat_database%' AND query NOT ILIKE '%pg_stat_clear_snapshot%'`;
      const sum = (await this.pool.query<{ exec: number | null; calls: string | null }>(
        `SELECT sum(total_exec_time)::float8 AS exec, sum(calls)::text AS calls FROM ${STATS_SCHEMA}.pg_stat_statements WHERE ${filter}`)).rows[0];
      const top = (await this.pool.query<{ query: string; calls: string; total: number; mean: number; rows: string }>(
        `SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 240) AS query, calls::text, total_exec_time::float8 AS total,
          mean_exec_time::float8 AS mean, rows::text FROM ${STATS_SCHEMA}.pg_stat_statements WHERE ${filter}
          ORDER BY total_exec_time DESC LIMIT 10`)).rows;
      return {
        transactions: after - before - probe,
        execMs: sum?.exec ?? 0,
        statementCalls: Number(sum?.calls ?? 0),
        top: top.map(row => ({ query: row.query, calls: Number(row.calls), totalExecMs: row.total, meanExecMs: row.mean, rows: Number(row.rows) })),
      };
    };
  }
}
