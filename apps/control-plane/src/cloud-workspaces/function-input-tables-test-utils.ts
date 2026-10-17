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

/** Words that can follow a FROM or JOIN item where an alias would stand. */
const NOT_AN_ALIAS = new Set(["on", "using", "where", "join", "inner", "left", "right", "full", "outer", "cross",
  "natural", "lateral", "group", "order", "limit", "offset", "having", "window", "union", "except", "intersect",
  "for", "and", "or", "returning", "set", "tablesample", "with"]);

/** Test support: by table, the columns `bodies` read as `alias.column` or
 * `table.column`, where a FROM or JOIN item of one of `tables` names the
 * alias. An alias that several items share counts for each of their tables.
 * A column read without a qualifier is not seen, so callers should pin a few
 * columns they know are read. */
export async function functionColumnReads(pool: pg.Pool, bodies: Iterable<string>, tables: Iterable<string>):
  Promise<Map<string, Set<string>>> {
  const add = (map: Map<string, Set<string>>, key: string, value: string) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(value);
  };
  const columns = new Map<string, Set<string>>();
  for (const row of (await pool.query<{ table: string; column: string }>(
    `SELECT relation.relname AS table, attribute.attname AS column
     FROM pg_attribute attribute JOIN pg_class relation ON relation.oid = attribute.attrelid
     WHERE relation.relnamespace = 'public'::regnamespace AND relation.relname = ANY($1::text[])
       AND attribute.attnum > 0 AND NOT attribute.attisdropped`, [[...tables]])).rows) add(columns, row.table, row.column);
  const reads = new Map<string, Set<string>>();
  for (const body of bodies) {
    const code = stripSqlLiterals(body).toLowerCase();
    const aliases = new Map<string, Set<string>>();
    for (const [, table, alias] of code.matchAll(
      /\b(?:from|join)\s+(?:public\.)?([a-z_][a-z0-9_$]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_$]*))?/g)) {
      if (!columns.has(table!)) continue;
      add(aliases, table!, table!);
      if (alias && !NOT_AN_ALIAS.has(alias)) add(aliases, alias, table!);
    }
    for (const [, alias, column] of code.matchAll(/(?<![\w$.])([a-z_][a-z0-9_$]*)\.([a-z_][a-z0-9_$]*)/g)) {
      for (const table of aliases.get(alias!) ?? []) if (columns.get(table)!.has(column!)) add(reads, table, column!);
    }
  }
  return reads;
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
