// Native integration check: real release migrations, runtime permissions,
// persisted data, and two independent PostgreSQL clusters on distinct ports.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { ensureWorkspace, systemEnvironment } from "./state.mjs";
import { startPostgres, pickServicePorts, migratePostgres } from "./postgres.mjs";
import { run } from "./processes.mjs";

const root = process.cwd(), require = createRequire(path.join(root, "apps/control-plane/package.json"));
const { Client } = require("pg");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-dev-postgres-check-"));
const clusters = [];
try {
  await run("pnpm", ["--dir", "apps/control-plane", "build"], { cwd: root, env: systemEnvironment(), label: "Control-plane build", timeout: 180_000 });
  for (const name of ["first", "second"]) {
    const repositoryRoot = path.join(directory, name); fs.mkdirSync(repositoryRoot);
    const workspace = ensureWorkspace({ repositoryRoot, homeDir: directory, env: {} }), ports = await pickServicePorts();
    const postgres = await startPostgres(workspace, {}, ports, root);
    clusters.push({ workspace, ports, postgres });
    await migratePostgres(workspace, {}, ports, root);
  }
  const first = clusters[0];
  const client = new Client({ connectionString: first.postgres.migrationUrl }); await client.connect();
  try { await client.query("CREATE TABLE dev_persistence_probe (id integer PRIMARY KEY)"); await client.query("INSERT INTO dev_persistence_probe VALUES (1)"); }
  finally { await client.end(); }
  await first.postgres.stop(); first.postgres = null;
  first.postgres = await startPostgres(first.workspace, {}, first.ports, root);
  await migratePostgres(first.workspace, {}, first.ports, root);
  for (let i = 0; i < clusters.length; i++) {
    const c = new Client({ connectionString: clusters[i].postgres.runtimeUrl }); await c.connect();
    try {
      const found = await c.query("SELECT to_regclass('public.dev_persistence_probe') IS NOT NULL AS present");
      if (found.rows[0].present !== (i === 0)) throw new Error("Database data crossed workspace boundaries");
      if (i === 0 && (await c.query("SELECT count(*)::int AS count FROM dev_persistence_probe")).rows[0].count !== 1) throw new Error("Restart lost persisted data");
    } finally { await c.end(); }
  }
  console.log("Dev PostgreSQL smoke passed: release migrations, limited runtime role, restart persistence, and independent checkouts.");
} catch {
  console.error("Dev PostgreSQL smoke failed. Private diagnostic state retained at the temporary test directory.");
  process.exitCode = 1;
} finally {
  let stopped = true;
  for (const { postgres } of clusters) if (postgres) await postgres.stop().catch(() => { stopped = false; });
  if (stopped && !process.exitCode) fs.rmSync(directory, { recursive: true, force: true });
  else console.error(`Inspect local state at ${directory}`);
}
