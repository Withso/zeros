import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type pg from "pg";

const migrations = [
  "0001_connections.sql",
  "0002_generation_revocations.sql",
  "0003_refresh_cooldown.sql",
  "0004_all_models.sql",
] as const;
/** Explicit owner-only command. The service never starts product migrations. */
export async function migrateDevConnections(pool: pg.Pool) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN; SELECT pg_advisory_xact_lock(730318510)");
    const product = await tx.query(
      "SELECT to_regclass('public.users') AS product",
    );
    if (product.rows[0].product)
      throw new Error("Dev connections requires a dedicated database");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS public.dev_connections_migrations(name text PRIMARY KEY, sha256 text NOT NULL)",
    );
    const ledger = (
      await tx.query<{ name: string; sha256: string }>(
        "SELECT name,sha256 FROM public.dev_connections_migrations ORDER BY name",
      )
    ).rows;
    if (ledger.some((r, i) => r.name !== migrations[i]))
      throw new Error("Unknown Dev connections migration");
    for (const name of migrations) {
      const sql = await readFile(
          new URL(`./migrations/${name}`, import.meta.url),
          "utf8",
        ),
        digest = createHash("sha256").update(sql).digest("hex");
      const row = ledger.find((r) => r.name === name);
      if (row) {
        if (row.sha256 !== digest)
          throw new Error("Dev connections migration checksum mismatch");
        continue;
      }
      await tx.query(sql);
      await tx.query(
        "INSERT INTO public.dev_connections_migrations VALUES($1,$2)",
        [name, digest],
      );
    }
    await tx.query(
      "GRANT SELECT ON public.dev_connections_migrations TO zeros_app",
    );
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
export async function checkDevConnectionsSchema(pool: pg.Pool) {
  const rows = (
    await pool.query<{ name: string; sha256: string }>(
      "SELECT name,sha256 FROM public.dev_connections_migrations ORDER BY name",
    )
  ).rows;
  if (rows.length !== migrations.length)
    throw new Error("Dev connections migrations required");
  for (const [i, name] of migrations.entries()) {
    const bytes = await readFile(
      new URL(`./migrations/${name}`, import.meta.url),
    );
    if (
      rows[i]?.name !== name ||
      rows[i]?.sha256 !== createHash("sha256").update(bytes).digest("hex")
    )
      throw new Error("Dev connections schema mismatch");
  }
}
