import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Hono } from "hono";
import type pg from "pg";
import type { Config } from "./config.js";
import { withSystemTx } from "./db.js";
import type { MigrationStatus } from "./migrate.js";
import { isNewerExpandMigration } from "./migration-phase.js";
import type { CloudWorkspaceReleaseHealthReader } from "./cloud-workspaces/health.js";
import { activeAlphaDeletionReadinessException } from "./cloud-workspaces/alpha-deletion-readiness.js";
import { readRuntimeReleaseIdentity } from "./cloud-workspaces/runtime-publication-routes.js";

type LedgerRow = { name: string; checksum: string | null; phase?: string | null };
type Dependencies = {
  sourceSha?: string;
  migrationStatus?: MigrationStatus;
  cloudWorkspaceHealthService?: CloudWorkspaceReleaseHealthReader;
  readManifest?: () => Promise<LedgerRow[]>;
  readLedger?: () => Promise<LedgerRow[]>;
  readWorkerQualified?: (provider: string, imageRef: string) => Promise<boolean>;
  readRuntimeIdentity?: () => ReturnType<typeof readRuntimeReleaseIdentity>;
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
    const configured = config.cloudWorkspaces;
    let cloud: { enabled: boolean; ready: boolean; state: string; operationalState?: "degraded" } =
      { enabled: !!configured, ready: !configured, state: configured ? "unknown" : "disabled" };
    let alphaReadinessException: { kind: "retired-boat-deletions"; expiresAt: string } | undefined;
    if (configured && !maintenance && migrations.state === "current") {
      try {
        const exception = activeAlphaDeletionReadinessException(config.alphaDeletionReadinessException, config.deploymentChannel);
        const service = deps.cloudWorkspaceHealthService;
        const measured = exception && service?.readForRelease
          ? await service.readForRelease(exception.sandboxIds)
          : { health: await service?.read(), stalledDeletionsDeferred: false };
        const health = measured.health;
        // Recheck after the database read: slow queries cannot extend the window.
        const deferred = !!exception && !!activeAlphaDeletionReadinessException(exception, config.deploymentChannel) &&
          measured.stalledDeletionsDeferred && health?.operationalState === "degraded" &&
          health.reasons.length === 1 && health.reasons[0] === "deletion_intent_stalled";
        const ready = (health?.operationalState === "healthy" || deferred) && health?.backgroundWorkers === "enabled" &&
          health.setupExecution === "enabled" && health.durability === "enabled";
        cloud = { enabled: true, ready, state: ready ? "healthy" : "unready",
          ...(deferred && ready ? { operationalState: "degraded" as const } : {}) };
        if (deferred && ready) alphaReadinessException = { kind: "retired-boat-deletions", expiresAt: exception!.expiresAt };
      } catch { /* Never reflect health diagnostics into the identity. */ }
    }
    // Image references are immutable public artifact identities, never URLs.
    const selected = configured ? { provider: configured.provider, imageRef: configured.imageRef, sourceSha: configured.sourceCommit,
      architecture: configured.architecture, storageMiB: configured.storageMiB } : config.selectedCloudWorker;
    const imageRef = selected?.imageRef;
    const validImage = selected?.provider === "boat"
      ? /^boat:[a-z0-9][a-z0-9-]{0,62}@sha256:[a-f0-9]{64}$/.test(imageRef ?? "")
      : selected?.provider === "daytona" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(imageRef ?? "");
    const worker = selected && typeof imageRef === "string" && validImage && sha(selected.sourceSha) &&
      ["linux/amd64", "linux/arm64"].includes(selected.architecture) && Number.isSafeInteger(selected.storageMiB) && selected.storageMiB > 0 ? {
      provider: selected.provider, imageRef, sourceSha: sha(selected.sourceSha),
      architecture: selected.architecture, storageMiB: selected.storageMiB,
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
    let runtimeV4: Awaited<ReturnType<typeof readRuntimeReleaseIdentity>> | undefined;
    if (config.cloudRuntimePublication && !maintenance && migrations.state === "current") {
      try {
        runtimeV4 = await (deps.readRuntimeIdentity ? deps.readRuntimeIdentity() :
          readRuntimeReleaseIdentity(pool, config.cloudWorkspaceNewRuntimeProfile ?? "legacy"));
      } catch { /* Registry visibility never changes v1 readiness or leaks diagnostics. */ }
    }
    return { version: 1 as const, ready: !!sourceSha && !maintenance && migrations.state === "current" && cloud.ready && (!configured || !!worker),
      sourceSha, channel: config.deploymentChannel, maintenance, migrations, cloud, worker, workerQualified,
      ...(alphaReadinessException ? { alphaReadinessException } : {}),
      ...(runtimeV4 ? { runtimeV4 } : {}) };
  }
  app.get("/v1/release-identity", async c => {
    c.header("Cache-Control", "no-store");
    if (!cached || cached.until <= Date.now()) {
      pending ??= read().then(body => { cached = { body,
        until: Math.min(Date.now() + 5_000, body.alphaReadinessException ? Date.parse(body.alphaReadinessException.expiresAt) : Infinity) };
        return body; }).finally(() => { pending = undefined; });
      await pending;
    }
    const body = cached!.body;
    // Qualification or registry reads can finish after the exception deadline.
    // Check again at the response boundary, including coalesced requests.
    if (body.alphaReadinessException && Date.parse(body.alphaReadinessException.expiresAt) <= Date.now()) {
      return c.json({ ...body, ready: false, cloud: { enabled: true, ready: false, state: "unready" },
        alphaReadinessException: undefined }, 503);
    }
    return c.json(body, body.ready ? 200 : 503);
  });
  return app;
}
