import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Hono } from "hono";
import type pg from "pg";
import type { Config } from "./config.js";
import { withSystemTx } from "./db.js";
import type { MigrationStatus } from "./migrate.js";
import { isNewerExpandMigration } from "./migration-phase.js";

type LedgerRow = { name: string; checksum: string | null; phase?: string | null };
type Dependencies = {
  sourceSha?: string;
  migrationStatus?: MigrationStatus;
  readManifest?: () => Promise<LedgerRow[]>;
  readLedger?: () => Promise<LedgerRow[]>;
};
const sha = (value: string | undefined | null) => /^[a-f0-9]{40}$/.test(value ?? "") ? value! : null;
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
async function packagedManifest(): Promise<LedgerRow[]> {
  const directory = new URL("../migrations/", import.meta.url);
  const files = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  return Promise.all(files.map(async name => ({ name, checksum: `sha256:${digest(await readFile(new URL(name, directory)))}` })));
}

/** Separate from liveness. Only an allowlist of release metadata is public;
 * no provider response, credentials, tenant counts or diagnostic strings pass
 * this boundary. Bounded caching coalesces anonymous polling per API replica. */
export function createReleaseIdentityRoutes(config: Config, pool: pg.Pool, deps: Dependencies = {}): Hono {
  const app = new Hono();
  const sourceSha = sha(deps.sourceSha ?? process.env.RAILWAY_GIT_COMMIT_SHA);
  let cached: { body: Awaited<ReturnType<typeof read>>; until: number } | undefined;
  let pending: Promise<Awaited<ReturnType<typeof read>>> | undefined;
  let manifest: Promise<LedgerRow[]> | undefined;
  async function read() {
    const maintenance = config.databaseMaintenanceMode || deps.migrationStatus?.state === "maintenance";
    let migrations: { state: "current" | "pending" | "controlled" | "unknown"; head: string | null; expectedHead: string | null; manifestSha256: string | null } = {
      state: "unknown", head: null, expectedHead: null, manifestSha256: null,
    };
    try {
      manifest ??= (deps.readManifest ?? packagedManifest)().catch(error => { manifest = undefined; throw error; });
      const expected = await manifest;
      const rows = await (deps.readLedger ? deps.readLedger() : withSystemTx(pool, async tx =>
        (await tx.query<LedgerRow>("SELECT name, checksum, COALESCE(to_jsonb(schema_migrations)->>'phase', 'legacy') AS phase FROM schema_migrations ORDER BY name")).rows, { consistentRead: true }));
      const expectedHead = expected.at(-1)?.name ?? null;
      const expectedSequence = Number(expectedHead?.slice(0, 4) ?? 0);
      const known = new Map(expected.map(row => [row.name, row.checksum]));
      const applied = new Map(rows.map(row => [row.name, row.checksum]));
      const invalid = expected.length === 0 || applied.size !== rows.length || rows.some(row =>
        known.has(row.name) ? known.get(row.name) !== row.checksum : !isNewerExpandMigration(row, expectedSequence));
      migrations = {
        state: invalid ? "unknown" : deps.migrationStatus?.state === "controlled_migration_pending" ? "controlled" : expected.every(row => applied.has(row.name)) ? "current" : "pending",
        head: invalid ? null : rows.map(row => row.name).sort().at(-1) ?? null,
        expectedHead,
        manifestSha256: digest(JSON.stringify(expected)),
      };
    } catch { /* Fail closed without exposing database errors. */ }
    const ready = !!sourceSha && !maintenance && migrations.state === "current";
    const cloud = { enabled: !!config.cloudV2, ready: !config.cloudV2 || ready,
      state: config.cloudV2 ? ready ? "healthy" : "unready" : "disabled" };
    // Retain the released response shape; v2 distributes a versioned runtime,
    // so there is no separately qualified VM image.
    return { version: 1 as const, ready, sourceSha, channel: config.deploymentChannel,
      maintenance, migrations, cloud, worker: null, workerQualified: false };
  }
  app.get("/v1/release-identity", async c => {
    c.header("Cache-Control", "no-store");
    if (!cached || cached.until <= Date.now()) {
      pending ??= read().then(body => { cached = { body, until: Date.now() + 5_000 }; return body; }).finally(() => { pending = undefined; });
      await pending;
    }
    return c.json(cached!.body, cached!.body.ready ? 200 : 503);
  });
  return app;
}
