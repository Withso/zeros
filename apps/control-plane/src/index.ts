// ──────────────────────────────────────────────────────────
// Zeros control plane — entrypoint.
// Boot order: config → pool → migrations (idempotent) → HTTP server.
// The HTTP surface itself lives in app.ts so it stays importable (and its
// middleware ORDER assertable) without booting a server.
// ──────────────────────────────────────────────────────────

import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { runServiceBootMigrations } from "./migrate.js";
import { loadEmailConfig } from "./email.js";
import { startGithubOauthCleanup } from "./github.js";
import { createApp } from "./app.js";
import {
  CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH,
  CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH,
  CLOUD_WORKSPACE_SETUP_ADMISSION_PATH,
  CLOUD_WORKSPACE_SETUP_RECOVERY_PATH,
  type CloudWorkspaceInternalSetupService,
} from "./cloud-workspaces/internal-routes.js";
import type { CloudWorkspaceAccessService } from "./cloud-workspaces/access.js";
import type { CloudWorkspaceRepositoryResolver } from "./cloud-workspaces/github-repositories.js";
import type { DatabaseCloudWorkspaceForkService } from "./cloud-workspaces/forks.js";
import type { DatabaseCloudWorkspaceReplicaService } from "./cloud-workspaces/replicas.js";
import type { DatabaseCloudWorkspaceHealthService } from "./cloud-workspaces/health.js";
import type { DatabaseCloudWorkspaceEngineClientAdmissionService } from "./cloud-workspaces/engine-client-admission.js";
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
const migrationResult = await runServiceBootMigrations(pool, {
  cloudWorkspacesEnabled: config.cloudWorkspaces !== null,
});
if (migrationResult.status.state === "controlled_migration_pending") {
  console.warn(
    `[migrate] service boot stopped before ${migrationResult.status.migration}; ` +
      `${migrationResult.status.dependentRuntime} runtime is disabled. ` +
      "Service boot ignores approval values; run the strict one-shot migrator " +
      "during a drained window before enabling it.",
  );
}
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
let stopCloudCheckpointRequestWorker = async () => {};
let stopCloudForkWorker = async () => {};
let stopCloudObjectMaintenanceWorker = async () => {};
let stopCloudOperationsWorker = async () => {};
let stopCloudOutboxWorker = async () => {};
let startCloudBackground = () => {};
let cloudWorkspaceInternalSetupService:
  | CloudWorkspaceInternalSetupService
  | undefined;
let cloudWorkspaceAccessService: CloudWorkspaceAccessService | undefined;
let cloudWorkspaceRepositoryResolver:
  | CloudWorkspaceRepositoryResolver
  | undefined;
let cloudWorkspaceForkService: DatabaseCloudWorkspaceForkService | undefined;
let cloudWorkspaceReplicaService:
  | DatabaseCloudWorkspaceReplicaService
  | undefined;
let cloudWorkspaceHealthService:
  | DatabaseCloudWorkspaceHealthService
  | undefined;
let cloudWorkspaceEngineClientAdmissionService:
  | DatabaseCloudWorkspaceEngineClientAdmissionService
  | undefined;
if (config.cloudWorkspaces) {
  const [
    { DaytonaWorkspaceProvider },
    { DatabaseDaytonaProviderResolver },
    { startCloudWorkspaceReconciler },
    { DaytonaSandboxCommandRunner },
    { DaytonaCloudWorkspaceSetupExecutor },
    { DatabaseCloudWorkspaceSetupAdmissionBroker },
    {
      CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH,
      DatabaseCloudWorkspaceEngineClientAdmissionService,
    },
    { DatabaseCloudWorkspaceSetupMaterialService },
    { GithubCloudWorkspaceCredentialBroker },
    { GithubCloudWorkspaceRepositoryResolver },
    { CloudWorkspaceSetupWorker },
    { sanitizeCloudWorkspaceSetupLog },
    { DatabaseCloudWorkspaceBlobService, FileCloudWorkspaceObjectStore },
    { DatabaseCloudWorkspaceContentService },
    { DatabaseCloudWorkspaceDurableRecordService },
    { DatabaseCloudWorkspaceUsageService },
    { DatabaseCloudWorkspaceSetupRecoveryService },
    { CloudWorkspaceCheckpointRequestWorker },
    {
      CloudWorkspaceAccessRevocationWorker,
      DatabaseCloudWorkspaceAccessService,
    },
    { CloudWorkspaceForkWorker, DatabaseCloudWorkspaceForkService },
    { DatabaseCloudWorkspaceReplicaService },
    { CloudWorkspaceObjectMaintenanceWorker },
    { CloudWorkspaceOperationsWorker },
    { DatabaseCloudWorkspaceHealthService },
    { CloudWorkspaceOutboxWorker, HttpCloudWorkspaceOutboxSink },
  ] = await Promise.all([
    import("./cloud-workspaces/daytona-provider.js"),
    import("./cloud-workspaces/provider-resolver.js"),
    import("./cloud-workspaces/reconciler.js"),
    import("./cloud-workspaces/daytona-command-runner.js"),
    import("./cloud-workspaces/daytona-setup-executor.js"),
    import("./cloud-workspaces/setup-admission-broker.js"),
    import("./cloud-workspaces/engine-client-admission.js"),
    import("./cloud-workspaces/setup-materials.js"),
    import("./cloud-workspaces/github-credentials.js"),
    import("./cloud-workspaces/github-repositories.js"),
    import("./cloud-workspaces/setup-worker.js"),
    import("./cloud-workspaces/setup-log.js"),
    import("./cloud-workspaces/object-store.js"),
    import("./cloud-workspaces/content-record.js"),
    import("./cloud-workspaces/durable-record.js"),
    import("./cloud-workspaces/usage.js"),
    import("./cloud-workspaces/setup-recovery.js"),
    import("./cloud-workspaces/checkpoint-requests.js"),
    import("./cloud-workspaces/access.js"),
    import("./cloud-workspaces/forks.js"),
    import("./cloud-workspaces/replicas.js"),
    import("./cloud-workspaces/object-maintenance.js"),
    import("./cloud-workspaces/operations.js"),
    import("./cloud-workspaces/health.js"),
    import("./cloud-workspaces/outbox.js"),
  ]);
  const cloud = config.cloudWorkspaces;
  cloudWorkspaceHealthService = new DatabaseCloudWorkspaceHealthService(pool, {
    setupExecutionEnabled: cloud.setupExecution !== null,
    durabilityEnabled: cloud.durability !== null,
    outboxDeliveryEnabled: cloud.outbox !== null,
  });
  const github = new GithubCloudWorkspaceCredentialBroker(config.github!);
  cloudWorkspaceRepositoryResolver = new GithubCloudWorkspaceRepositoryResolver(
    { credential: github },
  );
  const providerConfig = {
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
  } as const;
  const provider = new DaytonaWorkspaceProvider(providerConfig);
  const hostedCommandRunner = cloud.setupExecution
    ? new DaytonaSandboxCommandRunner({
        apiKey: cloud.apiKey,
        apiUrl: cloud.apiUrl,
        allowedToolboxOrigins: cloud.setupExecution.allowedToolboxOrigins,
        lookupTimeoutMs: 15_000,
        maxCommandTimeoutSeconds: cloud.setupExecution.timeoutSeconds,
        maxOutputBytes: 256 * 1024,
      })
    : undefined;
  const providerResolver = new DatabaseDaytonaProviderResolver({
    pool,
    hostedProvider: provider,
    hostedConfig: providerConfig,
    credentialKeys: cloud.providerCredentialKeys,
    workosEnabled: config.auth.provider === "workos",
    ...(hostedCommandRunner ? { hostedCommandRunner } : {}),
    ...(cloud.setupExecution
      ? {
          commandRunnerFactory: (connection: {
            apiKey: string;
            apiUrl: string;
          }) =>
            new DaytonaSandboxCommandRunner({
              ...connection,
              allowedToolboxOrigins:
                cloud.setupExecution!.allowedToolboxOrigins,
              lookupTimeoutMs: 15_000,
              maxCommandTimeoutSeconds: cloud.setupExecution!.timeoutSeconds,
              maxOutputBytes: 256 * 1024,
            }),
        }
      : {}),
  });
  cloudWorkspaceAccessService = new DatabaseCloudWorkspaceAccessService({
    pool,
    providerResolver,
    workosEnabled: config.auth.provider === "workos",
    previewBaseDomain: cloud.access.previewBaseDomain,
    forbiddenPorts: [22_222, cloud.setupExecution?.enginePort ?? 39_393],
    ...(cloud.setupExecution
      ? { runtimeEnginePort: cloud.setupExecution.enginePort }
      : {}),
  });
  const accessRevocationWorker = new CloudWorkspaceAccessRevocationWorker({
    pool,
    providerResolver,
    intervalMs: cloud.reconcileIntervalMs,
    leaseMs: Math.max(60_000, cloud.operationTimeoutSeconds * 2_000),
  });
  const checkpointRequestWorker = new CloudWorkspaceCheckpointRequestWorker(
    pool,
    { intervalMs: cloud.reconcileIntervalMs },
  );
  const contentService = new DatabaseCloudWorkspaceContentService({
    pool,
    workosEnabled: config.auth.provider === "workos",
  });
  const recordService = new DatabaseCloudWorkspaceDurableRecordService({
    pool,
    workosEnabled: config.auth.provider === "workos",
  });
  const usageService = new DatabaseCloudWorkspaceUsageService(
    pool,
    config.auth.provider === "workos",
  );
  let blobService: InstanceType<
    typeof DatabaseCloudWorkspaceBlobService
  > | null = null;
  let forkWorker: InstanceType<typeof CloudWorkspaceForkWorker> | null = null;
  let objectMaintenanceWorker: InstanceType<
    typeof CloudWorkspaceObjectMaintenanceWorker
  > | null = null;
  let operationsWorker: InstanceType<
    typeof CloudWorkspaceOperationsWorker
  > | null = null;
  if (cloud.durability) {
    const durability = cloud.durability;
    blobService = new DatabaseCloudWorkspaceBlobService({
      pool,
      objectStore: new FileCloudWorkspaceObjectStore(
        durability.objectStoreDirectory,
      ),
      encryptionKeys: durability.objectEncryptionKeys,
      keyVersion: durability.currentObjectEncryptionKeyVersion,
      workosEnabled: config.auth.provider === "workos",
    });
    cloudWorkspaceForkService = new DatabaseCloudWorkspaceForkService(
      pool,
      blobService,
      config.auth.provider === "workos",
    );
    cloudWorkspaceReplicaService = new DatabaseCloudWorkspaceReplicaService(
      pool,
      blobService,
      config.auth.provider === "workos",
    );
    forkWorker = new CloudWorkspaceForkWorker(pool, blobService, {
      intervalMs: cloud.reconcileIntervalMs,
      leaseMs: Math.max(60_000, cloud.operationTimeoutSeconds * 2_000),
    });
    objectMaintenanceWorker = new CloudWorkspaceObjectMaintenanceWorker(
      blobService,
      {
        intervalMs: Math.max(60_000, cloud.reconcileIntervalMs),
        leaseMs: Math.max(60_000, cloud.operationTimeoutSeconds * 2_000),
      },
    );
    operationsWorker = new CloudWorkspaceOperationsWorker(pool, blobService, {
      intervalMs: Math.max(5_000, cloud.reconcileIntervalMs),
      leaseMs: Math.max(60_000, cloud.operationTimeoutSeconds * 2_000),
    });
  }
  const outboxWorker = cloud.outbox
    ? new CloudWorkspaceOutboxWorker(
        pool,
        new HttpCloudWorkspaceOutboxSink(
          cloud.outbox.endpoint,
          cloud.outbox.signingSecret,
          cloud.outbox.timeoutMs,
        ),
        {
          intervalMs: cloud.reconcileIntervalMs,
          leaseMs: Math.max(30_000, cloud.outbox.timeoutMs * 2),
        },
      )
    : null;
  let setupWorker: InstanceType<typeof CloudWorkspaceSetupWorker> | null = null;
  if (cloud.setupExecution && blobService) {
    const setup = cloud.setupExecution;
    const endpoint = (path: string) => `${setup.controlPlaneOrigin}${path}`;
    cloudWorkspaceEngineClientAdmissionService =
      new DatabaseCloudWorkspaceEngineClientAdmissionService({
        pool,
        endpoint: endpoint(CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH),
        enginePort: setup.enginePort,
        workosEnabled: config.auth.provider === "workos",
      });
    const materials = new DatabaseCloudWorkspaceSetupMaterialService({
      pool,
      setupAudience: endpoint(CLOUD_WORKSPACE_SETUP_ADMISSION_PATH),
      engineRegistrationAudience: endpoint(
        CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH,
      ),
      engineHeartbeatAudience: endpoint(CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH),
      setupRecoveryEndpoint: endpoint(CLOUD_WORKSPACE_SETUP_RECOVERY_PATH),
      engineProtocolVersion: setup.engineProtocolVersion,
      enginePort: setup.enginePort,
      engineRegistrationTtlSeconds: setup.timeoutSeconds + 60,
      setupSecretEncryptionKeys: setup.setupSecretEncryptionKeys,
      currentSetupSecretEncryptionKeyVersion:
        setup.currentSetupSecretEncryptionKeyVersion,
      ...(setup.setupSecretKeyV1
        ? { setupSecretKeyV1: setup.setupSecretKeyV1 }
        : {}),
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
    const recoveryService = new DatabaseCloudWorkspaceSetupRecoveryService(
      pool,
      blobService,
    );
    cloudWorkspaceInternalSetupService = {
      redeem: (input) => materials.redeem(input),
      registerEngine: (input) => materials.registerEngine(input),
      heartbeat: (input) => materials.heartbeat(input),
      admitEngineClient: (input) =>
        cloudWorkspaceEngineClientAdmissionService!.consume(input),
      appendRecord: (input) => recordService.append(input),
      readRecordHead: (input) => recordService.headForEngine(input),
      appendContent: (input) => contentService.append(input),
      readContentHead: (input) => contentService.headForEngine(input),
      commitCheckpoint: (input) => contentService.commitCheckpoint(input),
      putBlob: (input) => blobService.put(input),
      getBlob: (input) => blobService.getForEngine(input),
      ingestUsage: (input) => usageService.ingestEngine(input),
      readRecoveryManifest: (input) => recoveryService.manifestPage(input),
      getRecoveryBlob: (input) => recoveryService.blob(input),
    };
    const admission = new DatabaseCloudWorkspaceSetupAdmissionBroker({
      pool,
      endpoint: endpoint(CLOUD_WORKSPACE_SETUP_ADMISSION_PATH),
      ttlSeconds: setup.admissionTtlSeconds,
      workosEnabled: config.auth.provider === "workos",
    });
    const executor = new DaytonaCloudWorkspaceSetupExecutor({
      admissionBroker: admission,
      commandRunnerResolver: async (execution) => {
        const resolved = await providerResolver.resolve({
          workspaceId: execution.workspaceId,
          organizationId: execution.organizationId,
          generation: execution.generation,
          purpose: "setup",
        });
        if (!resolved.commandRunner) {
          throw new Error("cloud setup command runner is unavailable");
        }
        return resolved.commandRunner;
      },
      engineProtocolVersion: setup.engineProtocolVersion,
      timeoutSeconds: setup.timeoutSeconds,
    });
    setupWorker = new CloudWorkspaceSetupWorker({
      pool,
      executor,
      workosEnabled: config.auth.provider === "workos",
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
      providerResolver,
      workosEnabled: config.auth.provider === "workos",
      intervalMs: cloud.reconcileIntervalMs,
      leaseMs: Math.max(10 * 60_000, cloud.operationTimeoutSeconds * 2_000),
    }).stop;
    stopCloudAccessRevocationWorker = accessRevocationWorker.start();
    stopCloudCheckpointRequestWorker = checkpointRequestWorker.start();
    if (forkWorker) stopCloudForkWorker = forkWorker.start();
    if (objectMaintenanceWorker) {
      stopCloudObjectMaintenanceWorker = objectMaintenanceWorker.start();
    }
    if (operationsWorker) {
      stopCloudOperationsWorker = operationsWorker.start();
    }
    if (outboxWorker) stopCloudOutboxWorker = outboxWorker.start();
    if (setupWorker) stopCloudSetupWorker = setupWorker.start();
    console.log(
      `[control-plane] cloud workspace reconciliation enabled (${provider.name}/${cloud.target}); setup=${setupWorker ? "enabled" : "paused"}; durability=${blobService ? "enabled" : "disabled"}; outbox=${outboxWorker ? "enabled" : "queued"}`,
    );
  };
}

const app = createApp(config, pool, emailConfig, {
  securityEventBroker,
  migrationStatus: migrationResult.status,
  ...(workosProvider ? { workosProvider } : {}),
  ...(cloudWorkspaceInternalSetupService
    ? { cloudWorkspaceInternalSetupService }
    : {}),
  ...(cloudWorkspaceAccessService ? { cloudWorkspaceAccessService } : {}),
  ...(cloudWorkspaceRepositoryResolver
    ? { cloudWorkspaceRepositoryResolver }
    : {}),
  ...(cloudWorkspaceForkService ? { cloudWorkspaceForkService } : {}),
  ...(cloudWorkspaceReplicaService ? { cloudWorkspaceReplicaService } : {}),
  ...(cloudWorkspaceEngineClientAdmissionService
    ? { cloudWorkspaceEngineClientAdmissionService }
    : {}),
  ...(cloudWorkspaceHealthService ? { cloudWorkspaceHealthService } : {}),
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
    stopCloudCheckpointRequestWorker(),
    stopCloudForkWorker(),
    stopCloudObjectMaintenanceWorker(),
    stopCloudOperationsWorker(),
    stopCloudOutboxWorker(),
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
