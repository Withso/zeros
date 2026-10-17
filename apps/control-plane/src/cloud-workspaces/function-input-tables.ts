import type pg from "pg";

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
