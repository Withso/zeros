// Config → pools → migrations → HTTP and the v2 relay. Account background
// queues and cloud VM lifecycle run only in worker/combined processes.
import { serve } from "@hono/node-server";
import { createCloudV2 } from "./cloud/composition.js";
import { workerPollingOptions } from "./worker-polling-config.js";
import { startWorkerNotifications } from "./worker-notifications.js";
import { loadConfig } from "./config.js";
import { createPool, createMigrationPool } from "./db.js";
import { assertHostedDatabaseOwnership } from "./development-environment.js";
import { runServiceBootMigrations, verifyMigrations, type ServiceBootMigrationResult } from "./migrate.js";
import { loadEmailConfig } from "./email.js";
import { startGithubOauthCleanup } from "./github.js";
import { createApp } from "./app.js";
import { PostgresSecurityEventBroker, SecurityEventPublisher } from "./security-events.js";
import { RailwayWorkOSProvider } from "./workos-provider.js";
import { startWorkOSSyncRuntime } from "./workos-sync-runtime.js";
import { configureControlPlaneTracing, createOtlpTraceExporter, shutdownControlPlaneTracing } from "./tracing.js";

const config = loadConfig();
const processRole = config.processRole ?? "combined";
if (config.tracesUrl) {
  configureControlPlaneTracing({ exporter: createOtlpTraceExporter(config.tracesUrl), sampleRatio: config.traceSampleRatio ?? 0,
    processRole, deploymentChannel: config.deploymentChannel });
}
// `servesApi`: an interactive pool and the cloud services behind requests and
// WebSocket upgrades. Realtime replicas serve only upgrades; they never mount
// the HTTP API and never start durable queue consumers (realtime.md).
const servesApi = processRole !== "worker";
const servesHttpApi = processRole === "api" || processRole === "combined";
const workerPool = processRole === "worker" || processRole === "combined"
  ? createPool(config.databaseUrl, { workload: "worker", applicationName: "zeros-workers" }) : null;
// A worker-only process uses its worker pool for readiness. It never creates
// an unused API pool, and API replicas never start durable queue consumers.
const pool = servesApi ? createPool(config.databaseUrl, {
  workload: "api", maxConnections: config.databasePoolMax ?? 6,
  ...(processRole === "realtime" ? { applicationName: "zeros-realtime" } : {}),
}) : workerPool!;
if (config.development && "generation" in config.development) {
  await assertHostedDatabaseOwnership(pool, config.development);
}
const emailConfig = loadEmailConfig();

// LISTEN is session-scoped and must bypass transaction poolers. All consumers
// share one disposable session, in an isolated pool using runtime privileges.
const listenerPool = createPool(config.databaseListenUrl ?? config.databaseUrl, {
  workload: "listener", maxConnections: 2, applicationName: "zeros-notifications", keepAlive: true,
});
const securityEventBroker = new PostgresSecurityEventBroker(listenerPool);
const workosProvider =
  config.auth.provider === "workos" && config.workos
    ? new RailwayWorkOSProvider(config.auth, config.workos)
    : undefined;
const migrationResult = await (async (): Promise<ServiceBootMigrationResult> => {
  // Maintenance deliberately works against both sides of a schema cutover.
  // It does no DDL or ledger repair and never claims the schema is current.
  if (config.databaseMaintenanceMode) return { ran: [], status: { state: "maintenance" } };
  if (config.databaseMigrationsOnBoot === false) return verifyMigrations(pool);
  const migrationPool = createMigrationPool(config.databaseMigrationUrl ?? config.databaseUrl, {
    maxConnections: 1,
    applicationName: "zeros-migrator",
    ...(config.databaseMigrationRole ? {role: config.databaseMigrationRole} : {}),
  });
  try {
    return await runServiceBootMigrations(migrationPool, {
      cloudWorkspacesEnabled: false,
    });
  } finally { await migrationPool.end(); }
})();
if (migrationResult.status.state === "controlled_migration_pending") {
  console.warn(
    `[migrate] service boot stopped before ${migrationResult.status.migration}; ` +
      `${migrationResult.status.dependentRuntime} runtime is disabled. ` +
      "Service boot ignores approval values; run the strict one-shot migrator " +
      "during a drained window before enabling it.",
  );
}
const stopGithubCleanup = config.github && workerPool && !config.databaseMaintenanceMode
  ? startGithubOauthCleanup(workerPool) : () => {};
const workosSync = workosProvider && workerPool && !config.databaseMaintenanceMode
  ? startWorkOSSyncRuntime({
      pool: workerPool,
      provider: workosProvider,
      email: emailConfig,
      ...workerPollingOptions(config.workerPollIntervalsMs, "workos"),
      deletionLifecycleEnabled:
        migrationResult.status.state !== "controlled_migration_pending",
    })
  : null;
if (workosSync) {
  console.log(
    migrationResult.status.state === "controlled_migration_pending"
      ? "[control-plane] WorkOS reconciliation and security outboxes enabled; deletion lifecycle paused at controlled migration boundary"
      : "[control-plane] WorkOS reconciliation, security outboxes, and deletion lifecycle enabled",
  );
}
const runtimeReady = !config.databaseMaintenanceMode && migrationResult.status.state === "current";
const cloudV2Lifecycle = processRole === "worker" || processRole === "combined";
// Cloud Computer builds hold an advisory lock for their whole run. Their own
// two connections, one build and one cleanup, keep those locks out of the
// worker pool's query slots.
const computerLockPool = runtimeReady && config.cloudV2 && cloudV2Lifecycle
  ? createPool(config.databaseUrl, { workload: "advisory-lock", applicationName: "zeros-computer-locks" }) : null;
const cloudV2 = runtimeReady ? createCloudV2(config, workerPool ?? pool, {
  relay: processRole === "realtime" || processRole === "combined",
  lifecycle: cloudV2Lifecycle,
}, securityEventBroker, listenerPool, ...(computerLockPool ? [computerLockPool] : [])) : null;
const stopCloudV2Lifecycle = cloudV2?.lifecycle?.start() ?? (async () => {});
const app = createApp(config, pool, emailConfig, {
  ...(cloudV2 && servesHttpApi ? { cloudV2: { routes: cloudV2.routes, proxy: cloudV2.proxy, workers: cloudV2.workers } } : {}),
  securityEventBroker,
  migrationStatus: migrationResult.status,
  ...(workosProvider ? { workosProvider } : {}),
});

let shuttingDown = false;
let stopSecurityEventPublisher = async () => {};
let stopWorkerNotifications = async () => {};
const server = serve({ fetch: app.fetch, port: config.port, ...(config.host ? { hostname: config.host } : {}) }, info => {
  if (shuttingDown) return;
  if (runtimeReady && workerPool) {
    const publisher = new SecurityEventPublisher(workerPool, console, workerPollingOptions(config.workerPollIntervalsMs, "security"));
    stopSecurityEventPublisher = publisher.start();
    stopWorkerNotifications = startWorkerNotifications(listenerPool, {
      security: () => publisher.notify(),
      ...(workosSync ? { workos: () => workosSync.notify() } : {}),
    });
  }
  console.log(`[control-plane] listening on :${info.port}`);
});
server.on("upgrade", (request, socket, head) => {
  if (!servesApi || shuttingDown || !runtimeReady) { socket.destroy(); return; }
  if (!cloudV2?.relay?.handleUpgrade(request, socket, head)) socket.destroy();
});

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopGithubCleanup();
  console.log(`[control-plane] ${signal}; draining`);
  cloudV2?.connections?.close();
  cloudV2?.promptSignals.wakeAll();
  const backgroundStopped = Promise.allSettled([
    stopCloudV2Lifecycle(), stopWorkerNotifications(), cloudV2?.loginChanges?.stop() ?? Promise.resolve(),
    cloudV2?.promptChanges?.stop() ?? Promise.resolve(),
    workosSync?.stop() ?? Promise.resolve(), securityEventBroker.stop(), stopSecurityEventPublisher(),
  ]);
  const deadline = setTimeout(() => process.exit(1), 15_000 + (config.shutdownDrainMs ?? 0));
  deadline.unref();
  server.close(() => {
    void backgroundStopped.then(async () => {
      await shutdownControlPlaneTracing(2_000);
      const pools = new Set([pool, listenerPool]);
      if (workerPool) pools.add(workerPool);
      if (computerLockPool) pools.add(computerLockPool);
      await Promise.all([...pools].map(value => value.end()));
    }).finally(() => { clearTimeout(deadline); process.exit(0); });
  });
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
