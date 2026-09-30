import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Hono } from "hono";
import type pg from "pg";
import type { Config } from "./config.js";
import { withSystemTx } from "./db.js";
import type { MigrationStatus } from "./migrate.js";
import type { CloudWorkspaceHealth } from "./cloud-workspaces/health.js";

type LedgerRow = { name: string; checksum: string | null };
type Dependencies = {
  sourceSha?: string;
  migrationStatus?: MigrationStatus;
  cloudWorkspaceHealthService?: { read(): Promise<CloudWorkspaceHealth> };
  readManifest?: () => Promise<LedgerRow[]>;
  readLedger?: () => Promise<LedgerRow[]>;
  readWorkerQualified?: (provider: string, imageRef: string) => Promise<boolean>;
};
const sha = (value: string | undefined | null) => /^[a-f0-9]{40}$/.test(value ?? "") ? value! : null;
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export function qualifiedWorkerMatrix(rows: Array<{ credential_kind: string; runtime_contract_sha256: string; profile: string; enabled: boolean; mcp_qualified: boolean }>) {
  if (rows.length > 100) return false;
  const required = ["claude-setup-token", "codex-chatgpt", "cursor-api-key"], contracts = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.enabled || !row.mcp_qualified || row.profile !== "zeros-cloud-worker-v3" || !/^[a-f0-9]{64}$/.test(row.runtime_contract_sha256) || !required.includes(row.credential_kind)) continue;
    const kinds = contracts.get(row.runtime_contract_sha256) ?? new Set<string>();
    kinds.add(row.credential_kind); contracts.set(row.runtime_contract_sha256, kinds);
  }
  return [...contracts.values()].some(kinds => required.every(kind => kinds.has(kind)));
}

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
        (await tx.query<LedgerRow>("SELECT name, checksum FROM schema_migrations ORDER BY name")).rows, { consistentRead: true }));
      const known = new Map(expected.map(row => [row.name, row.checksum]));
      const applied = new Map(rows.map(row => [row.name, row.checksum]));
      const invalid = expected.length === 0 || applied.size !== rows.length || rows.some(row => !known.has(row.name) || known.get(row.name) !== row.checksum);
      migrations = {
        state: invalid ? "unknown" : deps.migrationStatus?.state === "controlled_migration_pending" ? "controlled" : expected.every(row => applied.has(row.name)) ? "current" : "pending",
        head: invalid ? null : expected.filter(row => applied.has(row.name)).at(-1)?.name ?? null,
        expectedHead: expected.at(-1)?.name ?? null,
        manifestSha256: digest(JSON.stringify(expected)),
      };
    } catch { /* Fail closed without exposing database errors. */ }
    const configured = config.cloudWorkspaces;
    let cloud = { enabled: !!configured, ready: !configured, state: configured ? "unknown" : "disabled" };
    if (configured && !maintenance && migrations.state === "current") {
      try {
        const health = await deps.cloudWorkspaceHealthService?.read();
        const ready = health?.operationalState === "healthy" && health.backgroundWorkers === "enabled" &&
          health.setupExecution === "enabled" && health.durability === "enabled";
        cloud = { enabled: true, ready, state: ready ? "healthy" : "unready" };
      } catch { /* Never reflect health diagnostics into the identity. */ }
    }
    // Image references are immutable public artifact identities, never URLs.
    const imageRef = configured?.imageRef;
    const validImage = configured?.provider === "boat"
      ? /^boat:[a-z0-9][a-z0-9-]{0,62}@sha256:[a-f0-9]{64}$/.test(imageRef ?? "")
      : configured?.provider === "daytona" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(imageRef ?? "");
    const worker = configured && typeof imageRef === "string" && validImage && sha(configured.sourceCommit) &&
      ["linux/amd64", "linux/arm64"].includes(configured.architecture) && Number.isSafeInteger(configured.storageMiB) && configured.storageMiB > 0 ? {
      provider: configured.provider, imageRef, sourceSha: sha(configured.sourceCommit),
      architecture: configured.architecture, storageMiB: configured.storageMiB,
    } : null;
    let workerQualified = false;
    if (worker && cloud.ready && !maintenance && migrations.state === "current") {
      try {
        // Only the audited migration-owner operator can write these approvals.
        // Expose existence for the selected immutable image, never credential
        // kinds, account identities or evidence. Per-credential runtime
        // admission still enforces its exact contract and MCP qualification.
        workerQualified = deps.readWorkerQualified ? await deps.readWorkerQualified(worker.provider, worker.imageRef) :
          await withSystemTx(pool, async tx => qualifiedWorkerMatrix((await tx.query<Parameters<typeof qualifiedWorkerMatrix>[0][number]>(
            `SELECT credential_kind,runtime_contract_sha256,profile,enabled,mcp_qualified FROM cloud_agent_runtime_qualifications
             WHERE provider=$1 AND image_ref=$2 AND enabled
               AND profile='zeros-cloud-worker-v3' AND mcp_qualified LIMIT 101`,
            [worker.provider, worker.imageRef],
          )).rows), { consistentRead: true });
      } catch { /* Missing/unreadable approval must not authorize publication. */ }
    }
    return { version: 1 as const, ready: !!sourceSha && !maintenance && migrations.state === "current" && cloud.ready && (!configured || !!worker),
      sourceSha, channel: config.deploymentChannel, maintenance, migrations, cloud, worker, workerQualified };
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
