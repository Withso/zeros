import { quarantineRestoredConnections } from "./quarantine.js";
import { Hono } from "hono";
import { bootstrapDevConnectionDatabase } from "./bootstrap.js";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import pg from "pg";
import { workosMemberVerifier } from "./authentication.js";
import { DevConnectionBroker, nativeCodexRenewer } from "./broker.js";
import { loadDevConnectionsConfig } from "./config.js";
import { githubPorts } from "./github.js";
import { checkDevConnectionsSchema, migrateDevConnections } from "./migrate.js";
import { createDevConnectionsRoutes } from "./routes.js";
import { DevConnectionStore } from "./store.js";

/** Separate start target. Importing this module never starts the product server. */
export async function startDevConnections() {
  const config = loadDevConnectionsConfig();
  if (process.argv.includes("--bootstrap")) {
    await bootstrapDevConnectionDatabase(process.env);
    const health=new Hono();health.get("/healthz",c=>c.json({ok:true,service:"dev-connections",mode:"bootstrap",build:process.env.DEV_CONNECTIONS_BUILD}));
    const server=serve({fetch:health.fetch,port:config.port});return {server,shutdown:()=>server.close()};
  }
  if(process.env.DEV_CONNECTIONS_ADMIN_DATABASE_URL || process.env.DEV_CONNECTIONS_MIGRATION_DATABASE_URL)
    if(!process.argv.includes("--migrate") && !process.argv.includes("--quarantine-restored-backup"))throw new Error("Runtime must not retain database owner authority");
  const quarantine = process.argv.includes("--quarantine-restored-backup");
  const migration = process.argv.includes("--migrate") || quarantine;
  const connectionString = migration
    ? process.env.DEV_CONNECTIONS_MIGRATION_DATABASE_URL
    : config.databaseUrl;
  if (!connectionString)
    throw new Error("Dev connections migration authority required");
  const pool = new pg.Pool({
    connectionString,
    max: 8,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
    options: "-c role=none",
    application_name: "zeros-dev-connections",
  });
  pool.on("error", () => {
    console.error("Dev connections database connection lost");
  });
  if (migration) {
    try {
      if(quarantine){await checkDevConnectionsSchema(pool);await quarantineRestoredConnections(pool);}
      else await migrateDevConnections(pool);
    } finally {
      await pool.end();
    }
    return;
  }
  try {
    await checkDevConnectionsSchema(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const store = new DevConnectionStore(pool, config.keys),
    github = githubPorts(config.github);
  const broker = new DevConnectionBroker(store, {
    codex: nativeCodexRenewer,
    github: github.renew,
    githubAccess: github.access,
  });
  const app = createDevConnectionsRoutes({
    config,
    store,
    broker,
    verifyMember: workosMemberVerifier(config.auth),
    verifyGithub: github.identity,
    ready: () => checkDevConnectionsSchema(pool),
  });
  const server = serve({ fetch: app.fetch, port: config.port });
  const timer = setInterval(() => {
    void store.pruneAudit().catch(() => {
      /* issuance remains fail-closed */
    });
  }, 3600000);
  timer.unref();
  const shutdown = () => {
    clearInterval(timer);
    server.close(() => {
      void pool.end();
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { server, pool, shutdown };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void startDevConnections().catch(() => {
    console.error("Dev connections startup failed");
    process.exitCode = 1;
  });
}
