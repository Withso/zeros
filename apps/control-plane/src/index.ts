// ──────────────────────────────────────────────────────────
// Zeros control plane — entrypoint.
// Boot order: config → pool → migrations (idempotent) → HTTP server.
// The HTTP surface itself lives in app.ts so it stays importable (and its
// middleware ORDER assertable) without booting a server.
// ──────────────────────────────────────────────────────────

import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { runMigrations } from "./migrate.js";
import { loadEmailConfig } from "./email.js";
import { startGithubOauthCleanup } from "./github.js";
import { createApp } from "./app.js";
import { PostgresSecurityEventBroker } from "./security-events.js";
import { RailwayWorkOSProvider } from "./workos-provider.js";
import { startWorkOSSyncRuntime } from "./workos-sync-runtime.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const emailConfig = loadEmailConfig();

const securityEventBroker = new PostgresSecurityEventBroker(pool);
const workosProvider =
  config.auth.provider === "workos" && config.workos
    ? new RailwayWorkOSProvider(config.auth, config.workos)
    : undefined;
const app = createApp(config, pool, emailConfig, {
  securityEventBroker,
  ...(workosProvider ? { workosProvider } : {}),
});

await runMigrations(pool);
if (config.github) startGithubOauthCleanup(pool);
const workosSync = workosProvider
  ? startWorkOSSyncRuntime({
      pool,
      provider: workosProvider,
      email: emailConfig,
    })
  : null;
if (workosSync) {
  console.log(
    "[control-plane] WorkOS reconciliation and security outboxes enabled",
  );
}
let stopCloudReconciler = async () => {};
if (config.cloudWorkspaces) {
  const [{ DaytonaWorkspaceProvider }, { startCloudWorkspaceReconciler }] =
    await Promise.all([
      import("./cloud-workspaces/daytona-provider.js"),
      import("./cloud-workspaces/reconciler.js"),
    ]);
  const cloud = config.cloudWorkspaces;
  const provider = new DaytonaWorkspaceProvider({
    apiKey: cloud.apiKey,
    apiUrl: cloud.apiUrl,
    target: cloud.target,
    snapshotId: cloud.snapshotId,
    architecture: cloud.architecture,
    cpuMillicores: cloud.cpuMillicores,
    memoryMiB: cloud.memoryMiB,
    storageMiB: cloud.storageMiB,
    operationTimeoutSeconds: cloud.operationTimeoutSeconds,
    autoArchiveMinutes: cloud.autoArchiveMinutes,
  });
  stopCloudReconciler = startCloudWorkspaceReconciler({
    pool,
    provider,
    intervalMs: cloud.reconcileIntervalMs,
    leaseMs: Math.max(10 * 60_000, cloud.operationTimeoutSeconds * 2_000),
  }).stop;
  console.log(
    `[control-plane] cloud workspace reconciliation enabled (${provider.name}/${cloud.target})`,
  );
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[control-plane] listening on :${info.port}`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[control-plane] ${signal}; draining`);
  const reconciliationStopped = stopCloudReconciler();
  const workosSyncStopped = workosSync?.stop() ?? Promise.resolve();
  const securityEventsStopped = securityEventBroker.stop();
  const deadline = setTimeout(() => process.exit(1), 15_000);
  deadline.unref();
  server.close(() => {
    void Promise.all([
      reconciliationStopped,
      workosSyncStopped,
      securityEventsStopped,
    ])
      .then(() => pool.end())
      .finally(() => {
        clearTimeout(deadline);
        process.exit(0);
      });
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
