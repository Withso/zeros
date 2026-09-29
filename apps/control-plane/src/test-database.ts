// ──────────────────────────────────────────────────────────
// Reusable, already-migrated Postgres for DB-backed tests.
//
// Integration suites used to begin every test with `DROP SCHEMA public
// CASCADE` and a replay of the whole migration ladder: more than a second per
// test, and most of the control-plane CI job. `resetMigratedTestDatabase()`
// keeps the contract those suites rely on — each test starts from a freshly
// migrated public schema — while replaying the ladder only when the schema
// itself changed:
//
//   1. The Vitest global setup migrates once and records a baseline: an
//      OID-independent fingerprint of everything a rebuild recreates, and one
//      transaction that deletes every public row and restores the rows and
//      sequence positions the migrations themselves wrote.
//   2. Each reset compares a cheap catalog signature (row count and newest
//      xmin of every schema catalog) with the last schema it verified. DDL,
//      GRANT, trigger toggles and ownership changes all write catalog rows, so
//      a changed signature forces the full fingerprint, and a changed
//      fingerprint forces the original drop-and-replay rebuild.
//   3. Otherwise it runs the restore transaction with
//      session_replication_role=replica, so append-only guards and foreign
//      keys do not fire while the baseline rows are replaced.
//
// Only the public schema is reset, exactly as before. Roles, other schemas
// and database settings are cluster or database state the old rebuild never
// touched either. Full migration replay coverage stays in migrations.test.ts,
// which rebuilds and replays the ladder itself and never calls this helper.
// ──────────────────────────────────────────────────────────

import pg from "pg";
import { runMigrations } from "./migrate.js";

export interface MigratedTestDatabaseBaseline {
  schemaFingerprint: string;
  /** Null when the schema has a relation a row-level restore cannot recreate. */
  restoreSql: string | null;
}

declare module "vitest" {
  interface ProvidedContext {
    migratedTestDatabaseBaseline?: MigratedTestDatabaseBaseline;
  }
}

export type MigratedTestDatabaseReset = "restored" | "rebuilt";

// Catalog rows are rewritten, never updated in place, by every schema change.
// In-place updates are reserved for VACUUM/ANALYZE statistics, which leave a
// cheap signature unchanged without affecting what a test can observe.
const SIGNATURE_CATALOGS = [
  "pg_namespace",
  "pg_class",
  "pg_attribute",
  "pg_attrdef",
  "pg_constraint",
  "pg_index",
  "pg_inherits",
  "pg_trigger",
  "pg_policy",
  "pg_proc",
  "pg_type",
  "pg_enum",
  "pg_rewrite",
  "pg_sequence",
  "pg_operator",
  "pg_opclass",
  "pg_opfamily",
  "pg_cast",
  "pg_aggregate",
  "pg_collation",
  "pg_conversion",
  "pg_ts_config",
  "pg_ts_dict",
  "pg_extension",
  "pg_default_acl",
  "pg_statistic_ext",
] as const;

const CATALOG_SIGNATURE_SQL = `SELECT pg_catalog.concat_ws(',', ${SIGNATURE_CATALOGS.map(
  (catalog) =>
    `(SELECT pg_catalog.count(*) || ':' || COALESCE(pg_catalog.max(xmin::pg_catalog.text::pg_catalog.int8), 0) FROM pg_catalog.${catalog})`,
).join(", ")}) AS signature`;

// Names instead of OIDs, so a rebuilt schema matches the baseline it replaced.
// Temporary schemas and other non-public schemas are deliberately excluded:
// the rebuild never reset them.
const SCHEMA_FINGERPRINT_SQL = `
WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
parts(part, value) AS (
  SELECT 'schema', string_agg(format('%s|%s', pg_get_userbyid(n.nspowner), n.nspacl), ';')
    FROM pg_namespace n WHERE n.oid = (SELECT oid FROM ns)
  UNION ALL SELECT 'extension', string_agg(format('%s|%s|%s|%s', e.extname, e.extversion,
      e.extnamespace::regnamespace, pg_get_userbyid(e.extowner)), ';' ORDER BY e.extname)
    FROM pg_extension e
  UNION ALL SELECT 'relation', string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s|%s', c.relname, c.relkind,
      c.relpersistence, pg_get_userbyid(c.relowner), c.relacl, c.relrowsecurity, c.relforcerowsecurity,
      c.reloptions, c.relreplident, pg_get_expr(c.relpartbound, c.oid)), ';' ORDER BY c.relname)
    FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'column', string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s|%s', c.relname, a.attnum, a.attname,
      format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated, a.attisdropped,
      a.attacl, co.collname), ';' ORDER BY c.relname, a.attnum)
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
    WHERE c.relnamespace = (SELECT oid FROM ns) AND a.attnum > 0
  UNION ALL SELECT 'default', string_agg(format('%s|%s|%s', c.relname, d.adnum,
      pg_get_expr(d.adbin, d.adrelid)), ';' ORDER BY c.relname, d.adnum)
    FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid WHERE c.relnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'constraint', string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s', k.conrelid::regclass,
      k.contypid::regtype, k.conname, k.contype, k.convalidated, k.condeferrable, k.condeferred,
      pg_get_constraintdef(k.oid)), ';' ORDER BY k.conrelid::regclass::text, k.contypid::regtype::text, k.conname)
    FROM pg_constraint k WHERE k.connamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'index', string_agg(format('%s|%s|%s|%s', c.relname, i.indisvalid, i.indisclustered,
      pg_get_indexdef(i.indexrelid)), ';' ORDER BY c.relname)
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'inherits', string_agg(format('%s|%s|%s', i.inhrelid::regclass, i.inhparent::regclass,
      i.inhseqno), ';' ORDER BY i.inhrelid::regclass::text, i.inhseqno)
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE c.relnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'trigger', string_agg(format('%s|%s|%s', t.tgrelid::regclass, t.tgenabled,
      pg_get_triggerdef(t.oid)), ';' ORDER BY t.tgrelid::regclass::text, t.tgname)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = (SELECT oid FROM ns) AND NOT t.tgisinternal
  UNION ALL SELECT 'policy', string_agg(format('%s|%s|%s|%s|%s|%s|%s', p.polrelid::regclass, p.polname,
      p.polcmd, p.polpermissive, p.polroles::regrole[], pg_get_expr(p.polqual, p.polrelid),
      pg_get_expr(p.polwithcheck, p.polrelid)), ';' ORDER BY p.polrelid::regclass::text, p.polname)
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'function', string_agg(format('%s(%s)|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s', p.proname,
      pg_get_function_identity_arguments(p.oid), pg_get_userbyid(p.proowner), l.lanname, p.prokind,
      p.prosecdef, p.proleakproof, p.proisstrict, p.provolatile, p.proconfig, p.proacl,
      pg_get_function_result(p.oid), md5(p.prosrc)), ';'
      ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.pronamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'type', string_agg(format('%s|%s|%s|%s|%s|%s', t.typname, t.typtype,
      pg_get_userbyid(t.typowner), t.typacl, t.typnotnull, format_type(t.typbasetype, t.typtypmod)), ';'
      ORDER BY t.typname)
    FROM pg_type t WHERE t.typnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'enum', string_agg(format('%s|%s|%s', t.typname, e.enumsortorder, e.enumlabel), ';'
      ORDER BY t.typname, e.enumsortorder)
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'rule', string_agg(format('%s|%s|%s', r.ev_class::regclass, r.rulename, r.ev_enabled)
      || '|' || pg_get_ruledef(r.oid), ';' ORDER BY r.ev_class::regclass::text, r.rulename)
    FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE c.relnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'sequence', string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s', c.relname,
      format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement, s.seqmax, s.seqmin, s.seqcache,
      s.seqcycle), ';' ORDER BY c.relname)
    FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid WHERE c.relnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'default-acl', string_agg(format('%s|%s|%s', pg_get_userbyid(d.defaclrole),
      d.defaclobjtype, d.defaclacl), ';' ORDER BY pg_get_userbyid(d.defaclrole), d.defaclobjtype)
    FROM pg_default_acl d WHERE d.defaclnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'statistics', string_agg(pg_get_statisticsobjdef(s.oid), ';' ORDER BY s.stxname)
    FROM pg_statistic_ext s WHERE s.stxnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'operator', string_agg(format('%s(%s,%s)|%s|%s', o.oprname, o.oprleft::regtype,
      o.oprright::regtype, o.oprcode::regprocedure, pg_get_userbyid(o.oprowner)), ';'
      ORDER BY o.oprname, o.oprleft::regtype::text, o.oprright::regtype::text)
    FROM pg_operator o WHERE o.oprnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'operator-class', string_agg(format('%s|%s|%s', c.opcname, c.opcmethod::regclass,
      c.opcintype::regtype), ';' ORDER BY c.opcname, c.opcmethod::regclass::text)
    FROM pg_opclass c WHERE c.opcnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'operator-family', string_agg(format('%s|%s', f.opfname, f.opfmethod::regclass), ';'
      ORDER BY f.opfname, f.opfmethod::regclass::text)
    FROM pg_opfamily f WHERE f.opfnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'cast', string_agg(format('%s|%s|%s|%s', c.castsource::regtype, c.casttarget::regtype,
      c.castfunc::regprocedure, c.castcontext), ';' ORDER BY c.castsource::regtype::text, c.casttarget::regtype::text)
    FROM pg_cast c
    WHERE c.castfunc IN (SELECT oid FROM pg_proc WHERE pronamespace = (SELECT oid FROM ns))
       OR c.castsource IN (SELECT oid FROM pg_type WHERE typnamespace = (SELECT oid FROM ns))
       OR c.casttarget IN (SELECT oid FROM pg_type WHERE typnamespace = (SELECT oid FROM ns))
  UNION ALL SELECT 'collation', string_agg(format('%s|%s|%s', c.collname, c.collprovider, c.collencoding), ';'
      ORDER BY c.collname, c.collencoding)
    FROM pg_collation c WHERE c.collnamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'conversion', string_agg(c.conname, ';' ORDER BY c.conname)
    FROM pg_conversion c WHERE c.connamespace = (SELECT oid FROM ns)
  UNION ALL SELECT 'text-search', string_agg(name, ';' ORDER BY name) FROM (
      SELECT 'config:' || cfgname AS name FROM pg_ts_config WHERE cfgnamespace = (SELECT oid FROM ns)
      UNION ALL SELECT 'dictionary:' || dictname FROM pg_ts_dict WHERE dictnamespace = (SELECT oid FROM ns)) ts
)
SELECT md5(string_agg(part || '=' || coalesce(value, ''), E'\\n' ORDER BY part)) AS fingerprint FROM parts`;

// Every read below renders names, values and types schema-qualified in one
// fixed text format, so a later session's settings cannot change them.
const STABLE_TEXT_SETTINGS = `SET LOCAL search_path = pg_catalog;
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL IntervalStyle = postgres;
SET LOCAL TimeZone = 'UTC';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = hex;`;

// Per test file: Vitest runs each file in a fresh module graph.
let baseline: MigratedTestDatabaseBaseline | undefined;
let verifiedCatalogSignature: string | undefined;

/**
 * Return the database behind `pool` to its freshly migrated state. Call it
 * wherever a test would otherwise drop the public schema and run migrations.
 */
export async function resetMigratedTestDatabase(
  pool: pg.Pool,
): Promise<MigratedTestDatabaseReset> {
  baseline ??= await providedBaseline();
  if (baseline?.restoreSql && (await restoreBaseline(pool, baseline))) {
    return "restored";
  }
  await rebuildMigratedTestDatabase(pool);
  return "rebuilt";
}

/** Drop and replay the whole ladder, then record what the reset restores. */
export async function rebuildMigratedTestDatabase(
  pool: pg.Pool,
): Promise<MigratedTestDatabaseBaseline> {
  await pool.query(
    "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
  );
  await runMigrations(pool);
  const client = await pool.connect();
  try {
    const schemaFingerprint = await readSchemaFingerprint(client);
    if (baseline?.schemaFingerprint !== schemaFingerprint) {
      baseline = await captureBaseline(client, schemaFingerprint);
    }
    verifiedCatalogSignature = await readCatalogSignature(client);
    return baseline;
  } finally {
    client.release();
  }
}

async function providedBaseline(): Promise<
  MigratedTestDatabaseBaseline | undefined
> {
  const { inject } = await import("vitest");
  return inject("migratedTestDatabaseBaseline");
}

async function restoreBaseline(
  pool: pg.Pool,
  { schemaFingerprint, restoreSql }: MigratedTestDatabaseBaseline,
): Promise<boolean> {
  const client = await pool.connect();
  let discard = false;
  try {
    const signature = await readCatalogSignature(client);
    if (signature !== verifiedCatalogSignature) {
      if ((await readSchemaFingerprint(client)) !== schemaFingerprint) {
        return false;
      }
      verifiedCatalogSignature = signature;
    }
    await client.query(restoreSql!);
    return true;
  } catch {
    // A refused restore (for example, a login that may not set
    // session_replication_role) falls back to the rebuild, which reports
    // any real database error itself.
    await client.query("ROLLBACK").catch(() => {
      discard = true;
    });
    return false;
  } finally {
    client.release(discard);
  }
}

async function readCatalogSignature(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query<{ signature: string }>(
    CATALOG_SIGNATURE_SQL,
  );
  return rows[0]!.signature;
}

async function readSchemaFingerprint(client: pg.PoolClient): Promise<string> {
  await client.query(`BEGIN READ ONLY; ${STABLE_TEXT_SETTINGS}`);
  try {
    const { rows } = await client.query<{ fingerprint: string }>(
      SCHEMA_FINGERPRINT_SQL,
    );
    return rows[0]!.fingerprint;
  } finally {
    await client.query("COMMIT");
  }
}

async function captureBaseline(
  client: pg.PoolClient,
  schemaFingerprint: string,
): Promise<MigratedTestDatabaseBaseline> {
  await client.query(
    `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; ${STABLE_TEXT_SETTINGS}`,
  );
  try {
    const { rows: relations } = await client.query<{
      name: string;
      kind: string;
    }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name, c.relkind AS kind
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S', 'm', 'f')
        ORDER BY c.relname`,
    );
    // A materialized view or foreign table keeps contents a row restore
    // cannot recreate. Rebuilding every time stays correct, only slower.
    if (relations.some(({ kind }) => kind === "m" || kind === "f")) {
      return { schemaFingerprint, restoreSql: null };
    }
    const tables = relations.filter(({ kind }) => kind === "r");
    const sequences = relations.filter(({ kind }) => kind === "S");

    const populated = tables.length
      ? (
          await client.query<{ name: string }>(
            tables
              .map(
                ({ name }) =>
                  `SELECT ${pg.escapeLiteral(name)} AS name WHERE EXISTS (SELECT 1 FROM ONLY ${name})`,
              )
              .join(" UNION ALL "),
          )
        ).rows
      : [];
    const inserts: string[] = [];
    for (const { name } of populated) {
      const { rows: columns } = await client.query<{
        name: string;
        type: string;
      }>(
        `SELECT format('%I', attname) AS name, format_type(atttypid, atttypmod) AS type
           FROM pg_attribute
          WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
            AND attgenerated = ''
          ORDER BY attnum`,
        [name],
      );
      const tuple = columns
        .map(
          (column) =>
            `quote_nullable(${column.name}::text) || ${pg.escapeLiteral(`::${column.type}`)}`,
        )
        .join(" || ', ' || ");
      const { rows } = await client.query<{ tuples: string }>(
        `SELECT string_agg('(' || ${tuple} || ')', ', ') AS tuples FROM ONLY ${name}`,
      );
      inserts.push(
        `INSERT INTO ${name} (${columns.map((column) => column.name).join(", ")}) ` +
          `OVERRIDING SYSTEM VALUE VALUES ${rows[0]!.tuples};`,
      );
    }
    const positions = sequences.length
      ? (
          await client.query<{ name: string; value: string; called: boolean }>(
            sequences
              .map(
                ({ name }) =>
                  `SELECT ${pg.escapeLiteral(name)} AS name, last_value::text AS value, is_called AS called FROM ${name}`,
              )
              .join(" UNION ALL "),
          )
        ).rows
      : [];
    const restoreSql = [
      "BEGIN;",
      "SET LOCAL session_replication_role = replica;",
      STABLE_TEXT_SETTINGS,
      ...tables.map(({ name }) => `DELETE FROM ONLY ${name};`),
      ...inserts,
      ...(positions.length
        ? [
            `SELECT ${positions
              .map(
                ({ name, value, called }) =>
                  `setval(${pg.escapeLiteral(name)}::regclass, ${value}, ${called})`,
              )
              .join(", ")};`,
          ]
        : []),
      "COMMIT;",
    ].join("\n");
    return { schemaFingerprint, restoreSql };
  } finally {
    await client.query("COMMIT");
  }
}
