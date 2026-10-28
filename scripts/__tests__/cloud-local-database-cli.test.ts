import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const databaseScript = path.join(root, "scripts/dev-environment/database.mjs");
const owner = "a".repeat(24);
const request = {
  action: "inventory", owner, port: 23000,
  instanceId: "11111111-1111-4111-8111-111111111111",
  migrationUrl: `postgresql://zeros_dev_migrator:${"b".repeat(64)}@127.0.0.1:23000/zeros_dev_${owner}`,
  runtimeUrl: `postgresql://zeros_dev_runtime:${"c".repeat(64)}@127.0.0.1:23000/zeros_dev_${owner}`,
};

async function databaseCommand(action: "inventory" | "drain", fail = false) {
  const scratch = await mkdtemp(path.join(tmpdir(), "zeros-inventory-cli-"));
  try {
    const eventsFile = path.join(scratch, "events.jsonl");
    const record = `import { appendFileSync } from 'node:fs';
      const record = event => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(event) + '\\n');`;
    // Only the database/provider adapters are replaced. The real CLI owns its
    // stdin validation, operation dispatch, error boundary and pool lifetime.
    const driver = `${record}
      class Pool {
        constructor(options) { this.kind = new URL(options.connectionString).username.endsWith('runtime') ? 'runtime' : 'migration'; }
        ended = false;
        async query(sql) {
          if (this.ended) throw new Error('pool already closed');
          if (sql.includes('FROM public.zeros_cloud_local_identity')) return { rows: [{ owner: ${JSON.stringify(owner)}, instance_id: ${JSON.stringify(request.instanceId)} }] };
          if (sql.includes('FROM pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, migrator: false }] };
          if (sql.includes('has_schema_privilege')) return { rows: [{ ddl: false }] };
          if (${JSON.stringify(action)} === 'drain' && /cloud_v2_(workspaces|computer_builds|computers|tokens)/.test(sql)) return { rows: [] };
          if (sql.includes('FROM cloud_v2_workspaces')) return { rows: [{ count: 1 }] };
          throw new Error('unexpected fixture query');
        }
        async end() { this.ended = true; record(this.kind + '-end'); }
      }
      export const loadControlPlaneDependency = () => ({ Pool });
      export class DevEnvironmentError extends Error {}
      export const devEnvironmentDiagnostic = () => ({ code: 'fixture-failed' });`;
    const transaction = `${record}
      export async function withSystemTx(pool, callback) {
        record('inventory-start');
        // Hold the transaction over a real event-loop turn. Calling end while
        // acquisition is pending must fail, rather than hiding the CLI race.
        await new Promise(resolve => setImmediate(resolve));
        if (pool.ended) throw new Error('pool closed before inventory settled');
        if (${fail}) { record('inventory-failed'); throw new Error('synthetic-driver-secret'); }
        const result = await callback(pool);
        record('inventory-complete');
        return result;
      }`;
    const migration = `export const runMigrations = async () => {};
      export const planMigrations = async () => ({ pendingMigrations: [] });
      export const verifyMigrations = async () => {};
      export const migrationFailureDiagnostic = () => 'Migration failed. Check database connectivity and the migration configuration.';`;
    const substitutions = {
      [pathToFileURL(path.join(root, "scripts/dev-environment/dependency-preflight.mjs")).href]: driver,
      [pathToFileURL(path.join(root, "apps/control-plane/dist/db.js")).href]: transaction,
      [pathToFileURL(path.join(root, "apps/control-plane/dist/migrate.js")).href]: migration,
      [pathToFileURL(path.join(root, "apps/control-plane/dist/cloud/boat-client.js")).href]:
        `export class BoatApiClient { async request() { throw new Error('An empty drain must not contact Boat'); } }`,
      [pathToFileURL(path.join(root, "apps/control-plane/dist/cloud/resource-names.js")).href]:
        `export const cloudV2SnapshotName = () => 'unused'; export const cloudV2SandboxName = () => 'unused';`,
    };
    const loader = path.join(scratch, "adapters.mjs");
    await writeFile(loader, `import { registerHooks } from 'node:module';
      const substitutions = ${JSON.stringify(substitutions)};
      registerHooks({
        resolve(specifier, context, next) {
          if (Object.hasOwn(substitutions, specifier)) return { url: specifier, shortCircuit: true };
          return next(specifier, context);
        },
        load(url, context, next) {
          if (Object.hasOwn(substitutions, url)) return { format: 'module', source: substitutions[url], shortCircuit: true };
          return next(url, context);
        },
      });`);
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(process.execPath, ["--import", loader, databaseScript], {
        cwd: root, timeout: 15_000, env: { PATH: process.env.PATH },
      }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
      child.stdin!.end(JSON.stringify({ ...request, action, ...(action === "drain" ? { backendStopped: true } : {}) }));
    });
    const events = (await readFile(eventsFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string);
    return { ...result, events };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

describe("local cloud database CLI pool ownership", () => {
  it("finishes inventory before closing either owned pool", async () => {
    const result = await databaseCommand("inventory");
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ remainingWorkspaces: 1 });
    expect(result.events).toEqual(["inventory-start", "inventory-complete", "migration-end", "runtime-end"]);
  });

  it("closes both pools after a failed inventory without exposing driver output", async () => {
    const result = await databaseCommand("inventory", true);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("synthetic-driver-secret");
    expect(result.events).toEqual(["inventory-start", "inventory-failed", "migration-end", "runtime-end"]);
  });

  it("loads the empty resource drain from the real CLI without an entry-point import cycle", async () => {
    const result = await databaseCommand("drain");
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ complete: true, pending: 0 });
    expect(result.events).toEqual([
      "inventory-start", "inventory-complete", "inventory-start", "inventory-complete",
      "migration-end", "runtime-end",
    ]);
  });
});
