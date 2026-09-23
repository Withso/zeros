// ──────────────────────────────────────────────────────────
// Zeros control plane — entrypoint.
// Boot order: config → pool → migrations (idempotent) → HTTP server.
// The HTTP surface itself lives in app.ts so it stays importable (and its
// middleware ORDER assertable) without booting a server.
// ──────────────────────────────────────────────────────────

import { serve } from "@hono/node-server";
import {cloudAgentCredentialKeys} from "./cloud-workspaces/agent-credentials.js";
import {DatabaseCloudAgentExecutionService} from "./cloud-workspaces/agent-executions.js";
import { S3Client } from "@aws-sdk/client-s3";
import { Agent as HttpsAgent } from "node:https";
import { S3CloudWorkspaceObjectStore } from "./cloud-workspaces/s3-object-store.js";
import { DatabaseCloudWorkspaceActionService } from "./cloud-workspaces/action-receipts.js";
import { loadConfig } from "./config.js";
import { createPool, createMigrationPool } from "./db.js";
import { runServiceBootMigrations, verifyMigrations, type ServiceBootMigrationResult } from "./migrate.js";
import { loadEmailConfig, sendEmailStrict } from "./email.js";
import { startGithubOauthCleanup } from "./github.js";
import { createApp } from "./app.js";
import {
  CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH,
  CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH,
  CLOUD_WORKSPACE_SETUP_ADMISSION_PATH,
  CLOUD_WORKSPACE_SETUP_RECOVERY_PATH,
  type CloudWorkspaceInternalSetupService,
} from "./cloud-workspaces/internal-routes.js";
import type { DatabaseCloudWorkspaceAccessService } from "./cloud-workspaces/access.js";
import type { CloudWorkspaceRepositoryResolver } from "./cloud-workspaces/github-repositories.js";
import type { DatabaseCloudWorkspaceForkService } from "./cloud-workspaces/forks.js";
import type { DatabaseCloudWorkspaceReplicaService } from "./cloud-workspaces/replicas.js";
import type { DatabaseCloudWorkspaceHealthService } from "./cloud-workspaces/health.js";
import type { DatabaseCloudWorkspaceEngineClientAdmissionService } from "./cloud-workspaces/engine-client-admission.js";
import { DatabaseCloudRuntimeAccessAdmissionService } from "./cloud-workspaces/runtime-access-admission.js";
import { CloudRuntimeBridgeRelay } from "./cloud-workspaces/runtime-bridge.js";
import { CloudPreviewWebSocketRelay } from "./cloud-workspaces/preview-websocket-relay.js";
import { DatabaseCloudRuntimeServiceAccess } from "./cloud-workspaces/runtime-services.js";
import { createCloudRuntimeServiceRelay } from "./cloud-workspaces/runtime-service-relay.js";
import { DatabaseCloudWorkspaceCommandService } from "./cloud-workspaces/commands.js";
import { DatabaseCloudWorkspaceEventService } from "./cloud-workspaces/event-streams.js";
import { PostgresSecurityEventBroker,startSecurityEventPublisher } from "./security-events.js";
import { RailwayWorkOSProvider } from "./workos-provider.js";
import { startWorkOSSyncRuntime } from "./workos-sync-runtime.js";
import {CloudWorkspaceInvitationDeliveryWorker,workspaceInvitationDeliveryConfig,workspaceInvitationSender} from "./cloud-workspaces/invitation-delivery.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl, { maxConnections: config.databasePoolMax ?? 10 });
const emailConfig = loadEmailConfig();

// LISTEN is session-scoped and must bypass transaction poolers. The optional
// dedicated connection uses runtime privileges, never migration credentials.
const listenerPool = config.databaseListenUrl
  ? createPool(config.databaseListenUrl, {maxConnections: 1, applicationName: "zeros-security-listener"})
  : pool;
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
      cloudWorkspacesEnabled: config.cloudWorkspaces !== null,
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
if (config.github && !config.databaseMaintenanceMode) startGithubOauthCleanup(pool);
const workosSync = workosProvider && !config.databaseMaintenanceMode
  ? startWorkOSSyncRuntime({
      pool,
      provider: workosProvider,
      email: emailConfig,
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
let stopCloudReconciler = async () => {};
let stopCloudSetupWorker = async () => {};
let stopCloudAccessRevocationWorker = async () => {};
let stopCloudCheckpointRequestWorker = async () => {};
let stopCloudForkWorker = async () => {};
let stopCloudObjectMaintenanceWorker = async () => {};
let stopCloudOperationsWorker = async () => {};
let stopCloudOutboxWorker = async () => {};
let stopCloudInvitationWorker = async () => {};
let stopCloudHealthAlerts = async () => {};
let startCloudHealthAlerts = () => {};
let startCloudBackground = () => {};
let stopSecurityEventPublisher=async()=>{};
let cloudRuntimeBridge: CloudRuntimeBridgeRelay | null = null;
let cloudPreviewWebSocketRelay: CloudPreviewWebSocketRelay | null = null;
let cloudRuntimeServiceRelay: CloudPreviewWebSocketRelay | null = null;
let cloudRuntimeServiceAccess: DatabaseCloudRuntimeServiceAccess | undefined;
let cloudWorkspaceInternalSetupService:
  | CloudWorkspaceInternalSetupService
  | undefined;
let cloudWorkspaceAccessService: DatabaseCloudWorkspaceAccessService | undefined;
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
if (config.cloudWorkspaces && !config.databaseMaintenanceMode) {
  const [
    { createCloudProviderDeployment },
    { DatabaseCloudWorkspaceProviderResolver },
    { startCloudWorkspaceReconciler },
    { CloudWorkspaceLinuxSetupExecutor },
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
    { CloudWorkspaceHealthAlertWorker },
  ] = await Promise.all([
    import("./cloud-workspaces/provider-deployment.js"),
    import("./cloud-workspaces/provider-resolver.js"),
    import("./cloud-workspaces/reconciler.js"),
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
    import("./cloud-workspaces/health-alerts.js"),
  ]);
  const cloud = config.cloudWorkspaces;
  const invitationConfig=workspaceInvitationDeliveryConfig(cloud,config.inviteLinkBase,emailConfig);
  const invitationWorker=invitationConfig?new CloudWorkspaceInvitationDeliveryWorker(pool,invitationConfig,workspaceInvitationSender(emailConfig)):null;
  cloudWorkspaceHealthService = new DatabaseCloudWorkspaceHealthService(pool, {
    backgroundWorkersEnabled: cloud.backgroundWorkersEnabled !== false,
    setupExecutionEnabled: cloud.setupExecution !== null,
    durabilityEnabled: cloud.durability !== null,
    outboxDeliveryEnabled: cloud.outbox !== null,
  });
  const github = new GithubCloudWorkspaceCredentialBroker(config.github!);
  cloudWorkspaceRepositoryResolver = new GithubCloudWorkspaceRepositoryResolver(
    { credential: github },
  );
  const { provider, registry } = createCloudProviderDeployment(pool, cloud);
  const providerResolver = new DatabaseCloudWorkspaceProviderResolver({
    pool,
    credentialKeys: cloud.providerCredentialKeys,
    workosEnabled: config.auth.provider === "workos",
    registry,
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
  if (cloud.setupExecution) {
    cloudRuntimeServiceAccess = new DatabaseCloudRuntimeServiceAccess({
      pool, providerResolver, workosEnabled: config.auth.provider === "workos",
      publicOrigin: cloud.setupExecution.controlPlaneOrigin, enginePort: cloud.setupExecution.enginePort,
    });
    cloudRuntimeServiceRelay = createCloudRuntimeServiceRelay(cloudRuntimeServiceAccess);
  }
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
      objectStore: durability.s3
        ? new S3CloudWorkspaceObjectStore(new S3Client({
            endpoint: durability.s3.endpoint,
            region: durability.s3.region,
            credentials: { accessKeyId: durability.s3.accessKeyId, secretAccessKey: durability.s3.secretAccessKey },
            forcePathStyle: true,
            maxAttempts: 3,
            requestChecksumCalculation: "WHEN_REQUIRED",
            requestHandler: { connectionTimeout: 10_000, requestTimeout: 60_000, httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 16 }) },
          }), durability.s3.bucket)
        : new FileCloudWorkspaceObjectStore(durability.objectStoreDirectory),
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
    const blobs = blobService;
    const endpoint = (path: string) => `${setup.controlPlaneOrigin}${path}`;
    cloudWorkspaceEngineClientAdmissionService =
      new DatabaseCloudWorkspaceEngineClientAdmissionService({
        pool,
        endpoint: endpoint(CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH),
        enginePort: setup.enginePort,
        workosEnabled: config.auth.provider === "workos",
        relayEnabled: true,
      });
    const clientAdmission = cloudWorkspaceEngineClientAdmissionService;
    const sameRelayAuthority = (
      left: Awaited<ReturnType<typeof clientAdmission.authorizeRelay>>,
      right: NonNullable<typeof left>,
    ) =>
      left !== null &&
      left.workspaceId === right.workspaceId &&
      left.organizationId === right.organizationId &&
      left.generation === right.generation &&
      left.authorityEpoch === right.authorityEpoch &&
      left.engineInstanceId === right.engineInstanceId &&
      left.resourceId === right.resourceId;
    cloudRuntimeBridge = new CloudRuntimeBridgeRelay({
      resolve: async (token) => {
        const grant = await clientAdmission.authorizeRelay(token);
        if (!grant) return null;
        const { provider } = await providerResolver.resolve({
          workspaceId: grant.workspaceId,
          organizationId: grant.organizationId,
          generation: grant.generation,
          purpose: "preview",
        });
        const destination = provider.getEngineEndpoint
          ? await provider.getEngineEndpoint(grant.resourceId, setup.enginePort)
          : await provider.getPreviewEndpoint(
              grant.resourceId,
              setup.enginePort,
            );
        // Provider lookup can outlive a revoke/stop. Never open a relay using
        // authority observed only before that asynchronous boundary.
        if (
          !sameRelayAuthority(
            await clientAdmission.authorizeRelay(token),
            grant,
          )
        )
          return null;
        return { ...grant, endpoint: destination };
      },
      revalidate: async (token, grant) =>
        sameRelayAuthority(
          await clientAdmission.authorizeRelay(token, { connected: true }),
          grant,
        ),
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
      engineHeartbeatIntervalMs: setup.engineHeartbeatIntervalMs,
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
      blobs,
    );
    const runtimeAccess = new DatabaseCloudRuntimeAccessAdmissionService({
      pool,
      workosEnabled: config.auth.provider === "workos",
    });
    cloudWorkspaceInternalSetupService = {
      ...(cloudAgentCredentialKeys(cloud)?{agentExecutions:new DatabaseCloudAgentExecutionService(pool,cloudAgentCredentialKeys(cloud)!,config.auth.provider==="workos")}:{}),
      commands: new DatabaseCloudWorkspaceCommandService({ pool, workosEnabled: config.auth.provider === "workos" }),
      events: new DatabaseCloudWorkspaceEventService({ pool, workosEnabled: config.auth.provider === "workos" }),
      actions: new DatabaseCloudWorkspaceActionService({ pool, workosEnabled: config.auth.provider === "workos" }),
      redeem: (input) => materials.redeem(input),
      registerEngine: (input) => materials.registerEngine(input),
      heartbeat: (input) => materials.heartbeat(input),
      admitEngineClient: (input) =>
        cloudWorkspaceEngineClientAdmissionService!.consume(input),
      admitActorClient: (input) => cloudWorkspaceEngineClientAdmissionService!.consumeActor(input),
      admitRuntimeAccess: (input) => runtimeAccess.admit(input),
      appendRecord: (input) => recordService.append(input),
      readRecordHead: (input) => recordService.headForEngine(input),
      appendContent: (input) => contentService.append(input),
      readContentHead: (input) => contentService.headForEngine(input),
      commitCheckpoint: (input) => contentService.commitCheckpoint(input),
      authorizeBlobUpload: (token) => blobs.authorizeUpload(token),
      putBlob: (input) => blobs.put(input),
      putBlobBatch: (input) => blobs.putBatch(input),
      getBlob: (input) => blobs.getForEngine(input),
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
    const executor = new CloudWorkspaceLinuxSetupExecutor({
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
  // Alerts also run while background workers are paused: stalled work is
  // exactly what a paused environment should report.
  const alertEmail = config.operationsAlertEmail;
  const health = cloudWorkspaceHealthService;
  startCloudHealthAlerts = () => {
    if (!alertEmail) return;
    if (!emailConfig.apiKey || !emailConfig.from) {
      console.warn("[control-plane] cloud health alerts disabled: RESEND_API_KEY/EMAIL_FROM unset");
      return;
    }
    const service = (process.env.RAILWAY_SERVICE_NAME ?? "")
      .replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64) || "control-plane";
    stopCloudHealthAlerts = new CloudWorkspaceHealthAlertWorker({
      pool,
      environment: `${config.deploymentChannel}/${service}`,
      read: () => health.read(),
      send: (alert) => sendEmailStrict(emailConfig, alertEmail, alert.subject, alert.html,
        { idempotencyKey: alert.idempotencyKey }),
    }).start();
    console.log("[control-plane] cloud health alerts enabled");
  };
  startCloudBackground = () => {
    if (cloud.backgroundWorkersEnabled === false) {
      console.log("[control-plane] cloud workspace background workers paused");
      return;
    }
    stopCloudReconciler = startCloudWorkspaceReconciler({
      pool,
      provider,
      providerResolver,
      ...(cloud.computePolicy?{computePolicy:cloud.computePolicy}:{}),
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
    if (invitationWorker) stopCloudInvitationWorker=invitationWorker.start();

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
  ...(cloudRuntimeServiceAccess ? { cloudRuntimeServiceAccess } : {}),
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
  if(migrationResult.status.state==="current"){
    startCloudBackground();
    startCloudHealthAlerts();
    stopSecurityEventPublisher=startSecurityEventPublisher(pool);
  }
  console.log(`[control-plane] listening on :${info.port}`);
});
if (cloudWorkspaceAccessService && migrationResult.status.state !== "controlled_migration_pending") {
  const access = cloudWorkspaceAccessService;
  cloudPreviewWebSocketRelay = new CloudPreviewWebSocketRelay({
    recognizes: request => access.recognizesPreviewRequest(request),
    resolve: request => access.resolvePreviewWebSocket(request),
    revalidate: (request, grant) => access.revalidatePreviewWebSocket(request, grant),
  });
}
server.on("upgrade", (request, socket, head) => {
  if (shuttingDown || migrationResult.status.state !== "current") { socket.destroy(); return; }
  if (cloudRuntimeServiceRelay?.handleUpgrade(request, socket, head)) return;
  if (cloudPreviewWebSocketRelay?.handleUpgrade(request, socket, head)) return;
  if (!cloudRuntimeBridge?.handleUpgrade(request, socket, head)) socket.destroy();
});

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  cloudRuntimeBridge?.close();
  cloudPreviewWebSocketRelay?.close();
  cloudRuntimeServiceRelay?.close();
  console.log(`[control-plane] ${signal}; draining`);
  const backgroundStopped = Promise.allSettled([
    stopCloudSetupWorker(),
    stopCloudAccessRevocationWorker(),
    stopCloudCheckpointRequestWorker(),
    stopCloudForkWorker(),
    stopCloudObjectMaintenanceWorker(),
    stopCloudOperationsWorker(),
    stopCloudOutboxWorker(),
    stopCloudInvitationWorker(),
    stopCloudHealthAlerts(),
    stopCloudReconciler(),
    workosSync?.stop() ?? Promise.resolve(),
    securityEventBroker.stop(),
    stopSecurityEventPublisher(),
  ]);
  const deadline = setTimeout(() => process.exit(1), 15_000);
  deadline.unref();
  server.close(() => {
    void backgroundStopped
      .then(async () => { await pool.end(); if (listenerPool !== pool) await listenerPool.end(); })
      .finally(() => {
        clearTimeout(deadline);
        process.exit(0);
      });
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
