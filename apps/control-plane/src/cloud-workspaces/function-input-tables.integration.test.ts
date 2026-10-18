import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";

const url = process.env.TEST_DATABASE_URL, d = url ? describe : describe.skip;

describe("stripSqlLiterals", () => {
  it("drops comments and string literals but keeps quoted identifiers", () => {
    expect(stripSqlLiterals(`SELECT 'teams' FROM "users" u -- organizations\n/* devices */ WHERE x='it''s'`).replace(/\s+/g, " "))
      .toBe("SELECT '' FROM users u WHERE x=''");
  });
});

d("functionInputTables with PostgreSQL", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    await resetMigratedTestDatabase(pool);
    await pool.query(`CREATE FUNCTION zz_input_probe_callee() RETURNS bigint LANGUAGE sql AS $$
      SELECT count(*) FROM devices $$`);
    // Comma-joined FROM items, a LATERAL subquery and an EXISTS probe; the
    // string literal and comment name tables that must not count.
    await pool.query(`CREATE FUNCTION zz_input_probe() RETURNS bigint LANGUAGE sql AS $$
      SELECT count(*) FROM organizations o, teams t, public.team_members tm
      CROSS JOIN LATERAL (SELECT 1 FROM users account WHERE account.id = tm.user_id) a
      WHERE t.org_id = o.id AND EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id = o.id)
        AND 'cloud_workspaces' <> '' -- auth_sessions
        AND zz_input_probe_callee() >= 0 $$`);
  });
  afterAll(async () => { await pool?.end(); });

  it("finds comma-joined, lateral, EXISTS and callee tables and ignores literals", async () => {
    const { tables, functions } = await functionInputTables(pool, ["zz_input_probe"]);
    expect([...functions].sort()).toEqual(["zz_input_probe", "zz_input_probe_callee"]);
    expect([...tables].sort()).toEqual(["devices", "organization_members", "organizations", "team_members", "teams", "users"]);
  });
});

/** Test support: the tables a set of SQL functions can read, derived from
 * the live definitions instead of a hand-kept list. Every identifier in a
 * body (after string literals and comments are removed) that names a public
 * table counts, so comma-joined FROM items, LATERAL subqueries and EXISTS
 * probes are found as reliably as JOINs; an alias that happens to share a
 * table's name over-approximates, which only ever asks for more coverage.
 * Public functions called from a body are walked too, except the RLS
 * context helpers (`app_*`). */
export async function functionInputTables(pool: pg.Pool, roots: readonly string[]): Promise<{
  tables: Set<string>;
  functions: Set<string>;
  bodies: Map<string, string[]>;
}> {
  const publicFunctions = new Set((await pool.query<{ name: string }>(
    "SELECT DISTINCT proname AS name FROM pg_proc WHERE pronamespace='public'::regnamespace")).rows.map(row => row.name));
  const publicTables = new Set((await pool.query<{ name: string }>(
    "SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')")).rows.map(row => row.name));
  const tables = new Set<string>(), functions = new Set<string>(), bodies = new Map<string, string[]>();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop()!;
    if (functions.has(name)) continue;
    functions.add(name);
    const definitions = (await pool.query<{ body: string }>(
      "SELECT prosrc AS body FROM pg_proc WHERE proname=$1 AND pronamespace='public'::regnamespace", [name])).rows;
    if (!definitions.length) throw new Error(`function ${name} is not defined`);
    bodies.set(name, definitions.map(row => row.body));
    for (const { body } of definitions) {
      const code = stripSqlLiterals(body);
      for (const match of code.matchAll(/(?<![\w$.])(?:public\.)?([a-z_][a-z0-9_$]*)(?![\w$])(\s*\()?/gi)) {
        const word = match[1]!.toLowerCase();
        if (publicTables.has(word)) tables.add(word);
        if (match[2] && publicFunctions.has(word) && word !== name && !word.startsWith("app_")) queue.push(word);
      }
    }
  }
  return { tables, functions, bodies };
}

/** Removes comments, quoted strings and quoted identifiers' quotes so only
 * SQL code remains; quoted identifiers keep their text. */
export function stripSqlLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"((?:[^"]|"")*)"/g, (_all, inner: string) => inner.replace(/""/g, "\""));
}
