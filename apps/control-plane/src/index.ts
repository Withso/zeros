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
import {
  CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH,
  CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH,
  CLOUD_WORKSPACE_SETUP_ADMISSION_PATH,
  type CloudWorkspaceInternalSetupService,
} from "./cloud-workspaces/internal-routes.js";
import type { CloudWorkspaceAccessService } from "./cloud-workspaces/access.js";
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
let stopCloudSetupWorker = async () => {};
let stopCloudAccessRevocationWorker = async () => {};
let startCloudBackground = () => {};
let cloudWorkspaceInternalSetupService:
  | CloudWorkspaceInternalSetupService
  | undefined;
let cloudWorkspaceAccessService: CloudWorkspaceAccessService | undefined;
if (config.cloudWorkspaces) {
  const [
    { DaytonaWorkspaceProvider },
    { startCloudWorkspaceReconciler },
    { DaytonaSandboxCommandRunner },
    { DaytonaCloudWorkspaceSetupExecutor },
    { DatabaseCloudWorkspaceSetupAdmissionBroker },
    { DatabaseCloudWorkspaceSetupMaterialService },
    { GithubCloudWorkspaceCredentialBroker },
    { CloudWorkspaceSetupWorker },
    { sanitizeCloudWorkspaceSetupLog },
    {
      CloudWorkspaceAccessRevocationWorker,
      DatabaseCloudWorkspaceAccessService,
    },
  ] = await Promise.all([
    import("./cloud-workspaces/daytona-provider.js"),
    import("./cloud-workspaces/reconciler.js"),
    import("./cloud-workspaces/daytona-command-runner.js"),
    import("./cloud-workspaces/daytona-setup-executor.js"),
    import("./cloud-workspaces/setup-admission-broker.js"),
    import("./cloud-workspaces/setup-materials.js"),
    import("./cloud-workspaces/github-credentials.js"),
    import("./cloud-workspaces/setup-worker.js"),
    import("./cloud-workspaces/setup-log.js"),
    import("./cloud-workspaces/access.js"),
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
    autoStopMinutes: 0,
    autoArchiveMinutes: cloud.autoArchiveMinutes,
    autoDeleteMinutes: -1,
    allowedSshHosts: cloud.access.allowedSshHosts,
    allowedPreviewHostSuffixes: cloud.access.allowedPreviewHostSuffixes,
  });
  cloudWorkspaceAccessService = new DatabaseCloudWorkspaceAccessService({
    pool,
    provider,
    previewBaseDomain: cloud.access.previewBaseDomain,
    forbiddenPorts: [22_222, cloud.setupExecution?.enginePort ?? 39_393],
  });
  const accessRevocationWorker = new CloudWorkspaceAccessRevocationWorker({
    pool,
    provider,
    intervalMs: cloud.reconcileIntervalMs,
    leaseMs: Math.max(60_000, cloud.operationTimeoutSeconds * 2_000),
  });
  let setupWorker: InstanceType<typeof CloudWorkspaceSetupWorker> | null = null;
  if (cloud.setupExecution) {
    const setup = cloud.setupExecution;
    const endpoint = (path: string) => `${setup.controlPlaneOrigin}${path}`;
    const github = new GithubCloudWorkspaceCredentialBroker(config.github!);
    const materials = new DatabaseCloudWorkspaceSetupMaterialService({
      pool,
      setupAudience: endpoint(CLOUD_WORKSPACE_SETUP_ADMISSION_PATH),
      engineRegistrationAudience: endpoint(
        CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH,
      ),
      engineHeartbeatAudience: endpoint(CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH),
      engineProtocolVersion: setup.engineProtocolVersion,
      enginePort: setup.enginePort,
      engineRegistrationTtlSeconds: setup.timeoutSeconds + 60,
      setupSecretKeyV1: setup.setupSecretKeyV1,
      github,
      accountIdentityProvider: config.auth.provider,
      accountAuth:
        config.auth.provider === "workos"
          ? {
              jwksUrl: config.auth.jwksUrl,
              audience: config.auth.audience,
              issuers: [config.auth.issuer],
              contract: "zeros-access-v1",
              clientId: config.auth.desktopClientId,
            }
          : {
              jwksUrl: config.auth.jwksUrl,
              audience: config.auth.audience,
              issuers: config.auth.issuers,
              contract: null,
              clientId: null,
            },
    });
    cloudWorkspaceInternalSetupService = materials;
    const admission = new DatabaseCloudWorkspaceSetupAdmissionBroker({
      pool,
      endpoint: endpoint(CLOUD_WORKSPACE_SETUP_ADMISSION_PATH),
      ttlSeconds: setup.admissionTtlSeconds,
    });
    const commandRunner = new DaytonaSandboxCommandRunner({
      apiKey: cloud.apiKey,
      apiUrl: cloud.apiUrl,
      allowedToolboxOrigins: setup.allowedToolboxOrigins,
      lookupTimeoutMs: 15_000,
      maxCommandTimeoutSeconds: setup.timeoutSeconds,
      maxOutputBytes: 256 * 1024,
    });
    const executor = new DaytonaCloudWorkspaceSetupExecutor({
      admissionBroker: admission,
      commandRunner,
      engineProtocolVersion: setup.engineProtocolVersion,
      timeoutSeconds: setup.timeoutSeconds,
    });
    setupWorker = new CloudWorkspaceSetupWorker({
      pool,
      executor,
      sanitizeLog: sanitizeCloudWorkspaceSetupLog,
      intervalMs: setup.intervalMs,
      leaseMs: setup.leaseMs,
      heartbeatMs: Math.max(250, Math.floor(setup.leaseMs / 3)),
      executionTimeoutMs: (setup.timeoutSeconds + 15) * 1_000,
    });
  }
  startCloudBackground = () => {
    stopCloudReconciler = startCloudWorkspaceReconciler({
      pool,
      provider,
      intervalMs: cloud.reconcileIntervalMs,
      leaseMs: Math.max(10 * 60_000, cloud.operationTimeoutSeconds * 2_000),
    }).stop;
    stopCloudAccessRevocationWorker = accessRevocationWorker.start();
    if (setupWorker) stopCloudSetupWorker = setupWorker.start();
    console.log(
      `[control-plane] cloud workspace reconciliation enabled (${provider.name}/${cloud.target}); setup=${setupWorker ? "enabled" : "paused"}`,
    );
  };
}

const app = createApp(config, pool, emailConfig, {
  securityEventBroker,
  ...(workosProvider ? { workosProvider } : {}),
  ...(cloudWorkspaceInternalSetupService
    ? { cloudWorkspaceInternalSetupService }
    : {}),
  ...(cloudWorkspaceAccessService ? { cloudWorkspaceAccessService } : {}),
});

let shuttingDown = false;
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  if (shuttingDown) return;
  startCloudBackground();
  console.log(`[control-plane] listening on :${info.port}`);
});

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[control-plane] ${signal}; draining`);
  const backgroundStopped = Promise.allSettled([
    stopCloudSetupWorker(),
    stopCloudAccessRevocationWorker(),
    stopCloudReconciler(),
    workosSync?.stop() ?? Promise.resolve(),
    securityEventBroker.stop(),
  ]);
  const deadline = setTimeout(() => process.exit(1), 15_000);
  deadline.unref();
  server.close(() => {
    void backgroundStopped
      .then(() => pool.end())
      .finally(() => {
        clearTimeout(deadline);
        process.exit(0);
      });
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
