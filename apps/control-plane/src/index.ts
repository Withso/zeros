import { createCloudComputerRetirementWorker } from "./cloud-workspaces/computer-retirement.js";
// ──────────────────────────────────────────────────────────
// Zeros control plane — entrypoint.
// Boot order: config → pool → migrations (idempotent) → HTTP server.
// The HTTP surface itself lives in app.ts so it stays importable (and its
// middleware ORDER assertable) without booting a server.
// ──────────────────────────────────────────────────────────

import { serve } from "@hono/node-server";
import {cloudAgentCredentialKeys} from "./cloud-workspaces/agent-credentials.js";
import {DatabaseCloudAgentExecutionService} from "./cloud-workspaces/agent-executions.js";
import {DatabaseCloudComputerV2Service} from "./cloud-workspaces/computer-v2.js";
import { createComputerTemplateWorker } from "./cloud-workspaces/computer-template-worker-factory.js";
import { sanitizeComputerTemplateLog } from "./cloud-workspaces/computer-template-logs.js";
import {createRepositorySetupScriptWriter} from "./cloud-workspaces/computer-repository-setup.js";
import { S3Client } from "@aws-sdk/client-s3";
import { Agent as HttpsAgent } from "node:https";
import { S3CloudWorkspaceObjectStore } from "./cloud-workspaces/s3-object-store.js";
import { createRuntimeArtifactStore } from "./cloud-workspaces/runtime-artifact-store.js";
import { cloudRuntimeQualificationMode } from "./cloud-workspaces/runtime-config.js";
import { loadPinnedCloudRuntime } from "./cloud-workspaces/runtime-selection.js";
import { createRuntimeQualificationWorker } from "./cloud-workspaces/runtime-qualification.js";
import { createRuntimeImageWorker } from "./cloud-workspaces/runtime-images.js";
import { createCloudRuntimeStagingWorker } from "./cloud-workspaces/runtime-staging.js";
import { DatabaseCloudRuntimeTransitionService } from "./cloud-workspaces/runtime-transfer.js";
import { BoatApiClient } from "./cloud-workspaces/boat-client.js";
import { DatabaseBuilderVmOperationStore } from "./cloud-workspaces/cloud-builder-vm-store.js";
import { CloudComputerTemplateRetentionWorker } from "./cloud-workspaces/computer-template-retention.js";
import { startCloudWorkerNotifications, type CloudWorkerNotificationHandlers } from "./cloud-workspaces/worker-notifications.js";
import { workerPollingOptions } from "./worker-polling-config.js";
import { CloudEngineCheckpointHints, startCloudEngineCheckpointHintNotifications } from "./cloud-workspaces/engine-checkpoint-hints.js";
import { CloudEngineCheckpointProgress } from "./cloud-workspaces/checkpoint-progress.js";
import { DatabaseCloudWorkspaceActionService } from "./cloud-workspaces/action-receipts.js";
import { loadConfig } from "./config.js";
import { createPool, createMigrationPool, withSystemTx } from "./db.js";
import { assertHostedDatabaseOwnership } from "./development-environment.js";
import { runServiceBootMigrations, verifyMigrations, type ServiceBootMigrationResult } from "./migrate.js";
import { loadEmailConfig, sendEmailStrict } from "./email.js";
import { startGithubOauthCleanup } from "./github.js";
import { createApp } from "./app.js";
import type { CloudWorkspaceProviderResolver } from "./cloud-workspaces/provider-resolver.js";
import { DatabaseCloudGithubWriteGrants } from "./cloud-workspaces/github-write-grants.js";
import { DatabaseCloudGithubReads } from "./cloud-workspaces/github-read-proxy.js";
import { GithubCloudWorkspaceCredentialBroker } from "./cloud-workspaces/github-credentials.js";
import { DatabaseCloudIdleStop } from "./cloud-workspaces/idle-stop.js";
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
import type { CloudDirectProviderEndpointLookup } from "./cloud-workspaces/actor-sessions.js";
import { DatabaseCloudRuntimeAccessAdmissionService } from "./cloud-workspaces/runtime-access-admission.js";
import { CloudRuntimeBridgeRelay } from "./cloud-workspaces/runtime-bridge.js";
import { CloudPreviewWebSocketRelay } from "./cloud-workspaces/preview-websocket-relay.js";
import { DatabaseCloudRuntimeServiceAccess } from "./cloud-workspaces/runtime-services.js";
import { createCloudRuntimeServiceRelay } from "./cloud-workspaces/runtime-service-relay.js";
import { DatabaseCloudWorkspaceCommandService } from "./cloud-workspaces/commands.js";
import { DatabaseCloudWorkspaceEventService } from "./cloud-workspaces/event-streams.js";
import { PostgresSecurityEventBroker, SecurityEventPublisher } from "./security-events.js";
import { RolloutFlagSnapshot } from "./rollout-flags.js";
import { EngineAuthorityCache, installEngineAuthorityCache } from "./cloud-workspaces/engine-authority-cache.js";
import { CapabilitySigningKeyStore } from "./cloud-workspaces/capability-keys.js";
import { AuditUplinkSecurityAlerts } from "./realtime/uplink-alerts.js";
import { DatabaseUplinkCheckpointStore, UplinkCheckpointPush } from "./realtime/uplink-checkpoint.js";
import { DatabaseUplinkCredentialStore, UplinkCredentialPush } from "./realtime/uplink-cred.js";
import { uplinkCapabilityAuthority } from "./realtime/uplink-auth-source.js";
import { DatabaseUplinkAuthority } from "./realtime/uplink-authority.js";
import { DatabaseUplinkIdleStopStore } from "./realtime/uplink-idle.js";
import { DatabaseUplinkLeaseStore } from "./realtime/uplink-lease.js";
import { startUplinkNotifications } from "./realtime/uplink-notifications.js";
import { DatabaseUplinkPresenceStore, UplinkPresenceWriter } from "./realtime/uplink-presence.js";
import { CloudEngineUplinkServer, realtimeInstanceId } from "./realtime/uplink-server.js";
import { DatabaseUplinkTurnStore, UplinkTurnJournal } from "./realtime/uplink-turns.js";
import { DatabaseDeviceSessionAuthority } from "./realtime/device-sessions.js";
import { DatabaseDeviceStreamCatalogSource } from "./realtime/device-stream-catalog.js";
import { startDeviceStreamNotifications } from "./realtime/device-stream-notifications.js";
import { DEVICE_STREAM_PATH } from "./realtime/device-stream-protocol.js";
import { DeviceStreamServer } from "./realtime/device-stream-server.js";
import { DatabaseRealtimeSecurityEventFeed, DatabaseSecurityEventSource } from "./realtime/security-event-feed.js";
import { CapabilityRevocationPush, DatabaseCapabilityRevocationSource } from "./realtime/capability-revocation-push.js";
import { RailwayWorkOSProvider } from "./workos-provider.js";
import { startWorkOSSyncRuntime } from "./workos-sync-runtime.js";
import {CloudWorkspaceInvitationDeliveryWorker,workspaceInvitationDeliveryConfig,workspaceInvitationSender} from "./cloud-workspaces/invitation-delivery.js";
import { configureControlPlaneTracing, createOtlpTraceExporter, shutdownControlPlaneTracing } from "./tracing.js";

const config = loadConfig();
const runtimeArtifacts = createRuntimeArtifactStore({
  s3: config.cloudRuntimePublication?.s3 ?? config.cloudWorkspaces?.durability?.s3 ?? null,
});
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
let stopCloudReconciler = async () => {};
let stopCloudWorkerNotifications = async () => {};
let stopCloudCheckpointHintNotifications = async () => {};
let closeCloudCheckpointHints = () => {};
let stopCloudProAllowances = async () => {};
let stopCloudSetupWorker = async () => {};
let stopCloudComputerRetirementWorker = async () => {};
let stopCloudComputerTemplateWorker = async () => {};
let stopCloudRuntimeQualificationWorker = async () => {};
let stopCloudRuntimeImageWorker = async () => {};
let stopCloudRuntimeStagingWorker = async () => {};
let stopCloudComputerTemplateRetentionWorker = async () => {};
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
const workerNotifications: CloudWorkerNotificationHandlers = {};
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
let cloudWorkspaceProviderResolver: CloudWorkspaceProviderResolver | undefined;
let cloudDirectRoute: { enginePort: number; endpoint: CloudDirectProviderEndpointLookup } | undefined;
const runtimeReady = !config.databaseMaintenanceMode && migrationResult.status.state !== "controlled_migration_pending";
// Per-organization rollout flags for new cloud paths, read from memory on hot
// paths. Without the cloud runtime (maintenance, a pending controlled
// migration) every flag reads as off.
const rolloutFlagSnapshot = config.cloudWorkspaces && runtimeReady
  ? new RolloutFlagSnapshot({ pool, listenerPool }) : null;
const rolloutFlagsStarted = rolloutFlagSnapshot?.start();
// Engine authority cache: shadow comparison and fence-free reads, each behind
// its rollout flag. Without flags it only holds a LISTEN subscription.
const engineAuthorityCache = rolloutFlagSnapshot
  ? new EngineAuthorityCache({ pool, listenerPool, flags: rolloutFlagSnapshot }) : null;
engineAuthorityCache?.start();
installEngineAuthorityCache(engineAuthorityCache ?? undefined);
// S1 capability signing keys: a dedicated keyring opens the sealed current
// key; the store reloads on the keys NOTIFY. Without both envs there is no
// issuer and every capability route fails closed.
const capabilityKeyStore = rolloutFlagSnapshot && config.cloudWorkspaces?.capabilityKeyring
  ? new CapabilitySigningKeyStore({ pool, listenerPool, keyring: config.cloudWorkspaces.capabilityKeyring }) : null;
void capabilityKeyStore?.start();
const cloudCapabilities = capabilityKeyStore && config.cloudWorkspaces?.capabilityIssuer
  ? {
      pool, keyStore: capabilityKeyStore, issuer: config.cloudWorkspaces.capabilityIssuer,
      flags: rolloutFlagSnapshot!, workosEnabled: config.auth.provider === "workos",
    }
  : undefined;
// Historical Computer retirement holds session locks across provider I/O and
// query-pool callbacks. WorkOS may independently hold one worker query slot.
const retirementLockPool = workerPool && runtimeReady && config.cloudWorkspaces?.boat &&
  config.cloudWorkspaces.backgroundWorkersEnabled !== false
  ? createPool(config.databaseUrl, { workload: "retirement-lock", applicationName: "zeros-retirement-locks" }) : null;
const runtimeQualification = servesHttpApi && runtimeReady
  ? createRuntimeQualificationWorker(config, pool, runtimeArtifacts) : null;
const runtimeQualificationWorker = workerPool && runtimeReady
  ? createRuntimeQualificationWorker(config, workerPool, runtimeArtifacts) : null;
const runtimeImageWorker = workerPool && runtimeReady
  ? createRuntimeImageWorker(config, workerPool, runtimeArtifacts) : null;
const runtimeStagingWorker = workerPool && runtimeReady
  ? createCloudRuntimeStagingWorker(config, workerPool, runtimeArtifacts, new DatabaseCloudRuntimeTransitionService({
    pool: workerPool, qualificationMode: config.cloudWorkspaces?.runtime?.qualificationMode ?? "full",
    workosEnabled: config.auth.provider === "workos",
    secretEncryptionKeys: config.cloudWorkspaces?.settingsSecretEncryptionKeys ?? {},
    currentSecretEncryptionKeyVersion: config.cloudWorkspaces?.currentSettingsSecretEncryptionKeyVersion ?? null,
  })) : null;
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
    { DatabaseProMonthlyAllowance },
  ] = await Promise.all([
    import("./cloud-workspaces/provider-deployment.js"),
    import("./cloud-workspaces/provider-resolver.js"),
    import("./cloud-workspaces/reconciler.js"),
    import("./cloud-workspaces/linux-setup-executor.js"),
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
    import("./cloud-workspaces/pro-allowance.js"),
  ]);
  const cloud = config.cloudWorkspaces;
  const invitationConfig=workspaceInvitationDeliveryConfig(cloud,config.inviteLinkBase,emailConfig);
  const invitationWorker=invitationConfig&&workerPool?new CloudWorkspaceInvitationDeliveryWorker(workerPool,invitationConfig,workspaceInvitationSender(emailConfig),console,
    workerPollingOptions(config.workerPollIntervalsMs, "invitations")):null;
  cloudWorkspaceHealthService = new DatabaseCloudWorkspaceHealthService(pool, {
    backgroundWorkersEnabled: cloud.backgroundWorkersEnabled !== false,
    setupExecutionEnabled: cloud.setupExecution !== null,
    durabilityEnabled: cloud.durability !== null,
    outboxDeliveryEnabled: cloud.outbox !== null,
  });
  const github = new GithubCloudWorkspaceCredentialBroker(config.github!);
  const computerV2 = new DatabaseCloudComputerV2Service(pool, cloud, { sanitizeLog: sanitizeComputerTemplateLog });
  const computerTemplateWorker = workerPool && migrationResult.status.state !== "controlled_migration_pending"
    ? createComputerTemplateWorker(config, workerPool, runtimeArtifacts, github,
      new DatabaseCloudComputerV2Service(workerPool, cloud, { sanitizeLog: sanitizeComputerTemplateLog })) : null;
  cloudWorkspaceRepositoryResolver = new GithubCloudWorkspaceRepositoryResolver(
    { credential: github },
  );
  const { provider, registry } = createCloudProviderDeployment(pool, cloud, config.deploymentChannel);
  const providerResolver = new DatabaseCloudWorkspaceProviderResolver({
    pool,
    workosEnabled: config.auth.provider === "workos",
    registry,
  });
  cloudWorkspaceProviderResolver = providerResolver;
  // Provider adapters carry operation stores and template lookups. Sharing an
  // API adapter with a worker would silently cross the pool boundary again.
  const workerDeployment = workerPool === pool ? { provider, registry } : workerPool
    ? createCloudProviderDeployment(workerPool, cloud, config.deploymentChannel) : null;
  const workerProviderResolver = workerPool === pool ? providerResolver : workerPool
    ? new DatabaseCloudWorkspaceProviderResolver({ pool: workerPool,
      workosEnabled: config.auth.provider === "workos", registry: workerDeployment!.registry }) : null;

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
  if (cloud.setupExecution && servesApi) {
    cloudRuntimeServiceAccess = new DatabaseCloudRuntimeServiceAccess({
      pool, providerResolver, workosEnabled: config.auth.provider === "workos",
      publicOrigin: cloud.setupExecution.controlPlaneOrigin, enginePort: cloud.setupExecution.enginePort,
    });
    cloudRuntimeServiceRelay = createCloudRuntimeServiceRelay(cloudRuntimeServiceAccess);
  }
  const accessRevocationWorker = workerPool ? new CloudWorkspaceAccessRevocationWorker({
    pool: workerPool,
    providerResolver: workerProviderResolver!,
    ...workerPollingOptions(config.workerPollIntervalsMs, "access"),
    leaseMs: Math.max(60_000, cloud.operationTimeoutSeconds * 2_000),
  }) : null;
  const checkpointRequestWorker = workerPool ? new CloudWorkspaceCheckpointRequestWorker(
    workerPool,
    workerPollingOptions(config.workerPollIntervalsMs, "checkpoints"),
  ) : null;
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
    const blobOptions = {
      objectStore: durability.s3
        ? new S3CloudWorkspaceObjectStore(new S3Client({
            endpoint: durability.s3.endpoint,
            region: durability.s3.region,
            credentials: { accessKeyId: durability.s3.accessKeyId, secretAccessKey: durability.s3.secretAccessKey },
            forcePathStyle: true,
            maxAttempts: 3,
            requestChecksumCalculation: "WHEN_REQUIRED",
            requestHandler: { connectionTimeout: 10_000, requestTimeout: 60_000, httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 16 }) },
          }), durability.s3.bucket, durability.s3.prefix)
        : new FileCloudWorkspaceObjectStore(durability.objectStoreDirectory),
      encryptionKeys: durability.objectEncryptionKeys,
      keyVersion: durability.currentObjectEncryptionKeyVersion,
      restoreWindowMs: durability.objectRestoreWindowMs,
      workosEnabled: config.auth.provider === "workos",
    };
    blobService = new DatabaseCloudWorkspaceBlobService({ pool, ...blobOptions });
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
    if (workerPool) {
      const workerBlobs = new DatabaseCloudWorkspaceBlobService({ pool: workerPool, ...blobOptions });
      forkWorker = new CloudWorkspaceForkWorker(workerPool, workerBlobs, {
        ...workerPollingOptions(config.workerPollIntervalsMs, "forks"),
        leaseMs: Math.max(60_000, cloud.operationTimeoutSeconds * 2_000),
      });
      objectMaintenanceWorker = new CloudWorkspaceObjectMaintenanceWorker(
        workerBlobs,
        {
          ...workerPollingOptions(config.workerPollIntervalsMs, "objects"),
          leaseMs: Math.max(60_000, cloud.operationTimeoutSeconds * 2_000),
        },
      );
      operationsWorker = new CloudWorkspaceOperationsWorker(workerPool, workerBlobs, {
        ...workerPollingOptions(config.workerPollIntervalsMs, "operations"),
        leaseMs: Math.max(60_000, cloud.operationTimeoutSeconds * 2_000),
      });
    }
  }
  const outboxWorker = cloud.outbox && workerPool
    ? new CloudWorkspaceOutboxWorker(
        workerPool,
        new HttpCloudWorkspaceOutboxSink(
          cloud.outbox.endpoint,
          cloud.outbox.signingSecret,
          cloud.outbox.timeoutMs,
        ),
        {
          ...workerPollingOptions(config.workerPollIntervalsMs, "outbox"),
          leaseMs: Math.max(30_000, cloud.outbox.timeoutMs * 2),
        },
      )
    : null;
  let setupWorker: InstanceType<typeof CloudWorkspaceSetupWorker> | null = null;
  if (cloud.setupExecution && blobService && servesApi) {
    const setup = cloud.setupExecution;
    const blobs = blobService;
    const endpoint = (path: string) => `${setup.controlPlaneOrigin}${path}`;
    const directProviderEndpoint: CloudDirectProviderEndpointLookup = async scope=>{
      const {provider}=await providerResolver.resolve({organizationId:scope.organizationId,workspaceId:scope.workspaceId,generation:scope.generation,purpose:"preview"});
      if(provider.name!=="boat"||!provider.getEngineEndpoint||scope.remotePort!==setup.enginePort)
        throw new Error("cloud_actor_runtime_unavailable");
      return provider.getEngineEndpoint(scope.resourceId,setup.enginePort);
    };
    cloudDirectRoute = { enginePort: setup.enginePort, endpoint: directProviderEndpoint };
    cloudWorkspaceEngineClientAdmissionService =
      new DatabaseCloudWorkspaceEngineClientAdmissionService({
        pool,
        endpoint: endpoint(CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH),
        enginePort: setup.enginePort,
        workosEnabled: config.auth.provider === "workos",
        relayEnabled: true,
        directProviderEndpoint,
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
      left.resourceId === right.resourceId &&
      left.readOnly === right.readOnly;
    const bridge = cloud.bridge;
    console.log(
      `[cloud-bridge] limits connections=${bridge.maxConnections} ` +
        `writers_per_workspace=${bridge.maxConnectionsPerWorkspace} ` +
        `readers_per_workspace=${bridge.maxReadOnlyConnectionsPerWorkspace} ` +
        `outbound=${bridge.outboundBudgetBytes / 1_048_576}MiB ` +
        `inbound=${bridge.inboundBudgetBytes / 1_048_576}MiB`,
    );
    cloudRuntimeBridge = new CloudRuntimeBridgeRelay({
      ...bridge,
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
      resumeExistingEnabled: config.cloudWorkspaceResumeExistingEnabled === true,
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
    // Served by the API process itself, independent of background workers:
    // waiting engines share the dedicated notification session.
    const checkpointHints = new CloudEngineCheckpointHints(pool);
    const checkpointProgress = new CloudEngineCheckpointProgress(pool, { workosEnabled: config.auth.provider === "workos" });
    if (servesHttpApi) stopCloudCheckpointHintNotifications = startCloudEngineCheckpointHintNotifications(listenerPool, checkpointHints);
    closeCloudCheckpointHints = () => checkpointHints.close();
    cloudWorkspaceInternalSetupService = {
      ...(cloudAgentCredentialKeys(cloud)?{agentExecutions:new DatabaseCloudAgentExecutionService(pool,cloudAgentCredentialKeys(cloud)!,config.auth.provider==="workos",undefined,
        {computer:computerV2,updateRepositorySetupScript:createRepositorySetupScriptWriter(pool)}, {
          secretEncryptionKeys:cloud.settingsSecretEncryptionKeys,currentSecretEncryptionKeyVersion:cloud.currentSettingsSecretEncryptionKeyVersion,setupSecretKeyV1:cloud.settingsSecretKeyV1,
        })}:{}),
      commands: new DatabaseCloudWorkspaceCommandService({ pool, workosEnabled: config.auth.provider === "workos" }),
      events: new DatabaseCloudWorkspaceEventService({ pool, workosEnabled: config.auth.provider === "workos" }),
      actions: new DatabaseCloudWorkspaceActionService({ pool, workosEnabled: config.auth.provider === "workos" }),
      redeem: (input) => materials.redeem(input),
      registerEngine: (input) => materials.registerEngine(input),
      heartbeat: (input) => materials.heartbeat(input),
      waitForCheckpointHint: (input, signal) => checkpointHints.wait(input, signal),
      reportCheckpointProgress: input => checkpointProgress.report(input),
      admitEngineClient: (input) =>
        cloudWorkspaceEngineClientAdmissionService!.consume(input),
      admitActorClient: (input) => cloudWorkspaceEngineClientAdmissionService!.consumeActor(input),
      admitCapabilityActor: (input) => cloudWorkspaceEngineClientAdmissionService!.admitCapabilityActor(input),
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
  }
  if (cloud.setupExecution && blobService && workerPool) {
    const setup = cloud.setupExecution;
    const endpoint = (path: string) => `${setup.controlPlaneOrigin}${path}`;
    const admission = new DatabaseCloudWorkspaceSetupAdmissionBroker({
      pool: workerPool,
      endpoint: endpoint(CLOUD_WORKSPACE_SETUP_ADMISSION_PATH),
      ttlSeconds: setup.admissionTtlSeconds,
      workosEnabled: config.auth.provider === "workos",
    });
    const executor = new CloudWorkspaceLinuxSetupExecutor({
      diagnosticPool: workerPool,
      admissionBroker: admission,
      runtimeArtifacts,
      resolveRuntimeArtifact: (pin) => withSystemTx(workerPool, (tx) =>
        loadPinnedCloudRuntime(tx, pin, cloudRuntimeQualificationMode())),
      commandRunnerResolver: async (execution) => {
        const resolved = await workerProviderResolver!.resolve({
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
      pool: workerPool,
      executor,
      recoveryConfig: cloud,
      workosEnabled: config.auth.provider === "workos",
      sanitizeLog: sanitizeCloudWorkspaceSetupLog,
      ...workerPollingOptions(config.workerPollIntervalsMs, "setup"),
      leaseMs: setup.leaseMs,
      heartbeatMs: Math.max(250, Math.floor(setup.leaseMs / 3)),
      executionTimeoutMs: (setup.timeoutSeconds + 15) * 1_000,
    });
  }
  // Alerts also run while background workers are paused: stalled work is
  // exactly what a paused environment should report.
  const alertEmail = config.operationsAlertEmail;
  startCloudHealthAlerts = () => {
    if (!alertEmail || !workerPool) return;
    if (!emailConfig.apiKey || !emailConfig.from) {
      console.warn("[control-plane] cloud health alerts disabled: RESEND_API_KEY/EMAIL_FROM unset");
      return;
    }
    const service = (process.env.RAILWAY_SERVICE_NAME ?? "")
      .replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64) || "control-plane";
    const health = new DatabaseCloudWorkspaceHealthService(workerPool, {
      backgroundWorkersEnabled: cloud.backgroundWorkersEnabled !== false,
      setupExecutionEnabled: cloud.setupExecution !== null,
      durabilityEnabled: cloud.durability !== null,
      outboxDeliveryEnabled: cloud.outbox !== null,
    });
    stopCloudHealthAlerts = new CloudWorkspaceHealthAlertWorker({
      pool: workerPool,
      environment: `${config.deploymentChannel}/${service}`,
      read: () => health.read(),
      send: (alert) => sendEmailStrict(emailConfig, alertEmail, alert.subject, alert.html,
        { idempotencyKey: alert.idempotencyKey }),
    }).start();
    console.log("[control-plane] cloud health alerts enabled");
  };
  startCloudBackground = () => {
    if (!workerPool) return;
    if (cloud.backgroundWorkersEnabled === false) {
      console.log("[control-plane] cloud workspace background workers paused");
      return;
    }
    const lifecycle = startCloudWorkspaceReconciler({
      pool: workerPool,
      provider: workerDeployment!.provider,
      providerResolver: workerProviderResolver!,
      runtimeUpgradeConfig: cloud,
      ...(cloud.computePolicy?{computePolicy:cloud.computePolicy}:{}),
      workosEnabled: config.auth.provider === "workos",
      ...workerPollingOptions(config.workerPollIntervalsMs, "lifecycle"),
      leaseMs: Math.max(10 * 60_000, cloud.operationTimeoutSeconds * 2_000),
    });
    stopCloudReconciler = lifecycle.stop;
    if(cloud.computePolicy)stopCloudProAllowances=new DatabaseProMonthlyAllowance(workerPool,cloud.computePolicy).start();
    stopCloudAccessRevocationWorker = accessRevocationWorker!.start();
    stopCloudCheckpointRequestWorker = checkpointRequestWorker!.start();
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
    const retirementWorker = createCloudComputerRetirementWorker(workerPool, cloud, {
      ...workerPollingOptions(config.workerPollIntervalsMs, "retirement"),
      ...(retirementLockPool ? { lockPool: retirementLockPool } : {}),
    });
    stopCloudComputerRetirementWorker = retirementWorker.start();
    if (runtimeStagingWorker) stopCloudRuntimeStagingWorker = runtimeStagingWorker.start();
    Object.assign(workerNotifications, {
      lifecycle: () => lifecycle.reconciler.notify(),
      jobs: () => lifecycle.reconciler.notify(),
      setup: () => setupWorker?.notify(),
      recovery: () => setupWorker?.notify(),
      access: () => accessRevocationWorker!.notify(),
      checkpoints: () => checkpointRequestWorker!.notify(),
      ...(outboxWorker ? { outbox: () => outboxWorker.notify() } : {}),
      ...(invitationWorker ? { invitations: () => invitationWorker.notify() } : {}),
      ...(forkWorker ? { forks: () => forkWorker.notify() } : {}),
      ...(operationsWorker ? { operations: () => operationsWorker.notify() } : {}),
      retirement: () => retirementWorker.notify(),
      ...(computerTemplateWorker || runtimeImageWorker ? { templates: () => {
        computerTemplateWorker?.notify(); runtimeImageWorker?.notify();
      } } : {}),
      ...(runtimeStagingWorker || runtimeImageWorker ? { runtimeStaging: () => {
        runtimeStagingWorker?.notify(); runtimeImageWorker?.notify();
      } } : {}),
    } satisfies CloudWorkerNotificationHandlers);
    if (runtimeQualificationWorker) stopCloudRuntimeQualificationWorker = runtimeQualificationWorker.start();
    if (runtimeImageWorker) stopCloudRuntimeImageWorker = runtimeImageWorker.start();
    if (computerTemplateWorker) stopCloudComputerTemplateWorker = computerTemplateWorker.start();
    if (
      config.deploymentChannel === "alpha" &&
      cloud.provider === "boat" &&
      cloud.boat
    ) {
      stopCloudComputerTemplateRetentionWorker = new CloudComputerTemplateRetentionWorker(workerPool, {
        accountScope: cloud.boat.accountScope,
        billingOrg: cloud.boat.billingOrg,
        journal: new DatabaseBuilderVmOperationStore(workerPool, cloud.boat.accountScope),
        client: new BoatApiClient({
          apiKey: cloud.apiKey,
          billingOrg: cloud.boat.billingOrg,
          timeoutMs: 45_000,
        }),
      }).start(listenerPool);
    }
    console.log(
      `[control-plane] cloud workspace reconciliation enabled (${provider.name}/${cloud.target}); setup=${setupWorker ? "enabled" : "paused"}; durability=${blobService ? "enabled" : "disabled"}; outbox=${outboxWorker ? "enabled" : "queued"}`,
    );
  };
}

const cloudGithubWriteGrants = config.github && cloudWorkspaceInternalSetupService && servesHttpApi
  ? new DatabaseCloudGithubWriteGrants(pool, config.auth.provider === "workos") : undefined;
const cloudGithubReads = config.github && cloudWorkspaceInternalSetupService && servesHttpApi
  ? new DatabaseCloudGithubReads(pool, config.auth.provider === "workos", new GithubCloudWorkspaceCredentialBroker(config.github)) : undefined;
const cloudGithubWriteCleanup = workerPool && config.github && runtimeReady &&
  config.cloudWorkspaces?.setupExecution && config.cloudWorkspaces.durability
  ? new DatabaseCloudGithubWriteGrants(workerPool, config.auth.provider === "workos") : undefined;
let githubWriteCleanup: ReturnType<typeof setInterval> | undefined;
let githubWriteCleanupPending = Promise.resolve();
let githubWriteCleanupRunning = false;
const app = createApp(config, pool, emailConfig, {
  runtimePublication: { artifacts: runtimeArtifacts,
    ...(runtimeQualification ? { enqueueSmoke: (id: string) => runtimeQualification.enqueue(id),
      requalify: (id: string) => runtimeQualification.enqueue(id, { force: true }) } : {}) },
  ...(cloudWorkspaceInternalSetupService ? { cloudIdleStop: new DatabaseCloudIdleStop(pool, config.auth.provider === "workos") } : {}),
  ...(cloudGithubWriteGrants ? { cloudGithubWriteGrants } : {}),
  ...(cloudGithubReads ? { cloudGithubReads } : {}),
  securityEventBroker,
  migrationStatus: migrationResult.status,
  ...(workosProvider ? { workosProvider } : {}),
  ...(cloudWorkspaceInternalSetupService
    ? { cloudWorkspaceInternalSetupService }
    : {}),
  // Advertise the uplink only where engines register (the API surface), only
  // with a configured realtime origin, and read the same flag the realtime
  // server enforces so an off flag never attracts dials it would refuse.
  ...(cloudWorkspaceInternalSetupService && rolloutFlagSnapshot && config.cloudWorkspaces?.setupExecution?.engineUplinkEndpoint
    ? { cloudWorkspaceEngineUplink: {
        endpoint: config.cloudWorkspaces.setupExecution.engineUplinkEndpoint,
        flags: rolloutFlagSnapshot } }
    : {}),
  // The device-stream ticket names the stream on the same realtime origin.
  ...(rolloutFlagSnapshot && config.cloudWorkspaces?.setupExecution?.engineUplinkEndpoint
    ? { deviceSessions: {
        flags: rolloutFlagSnapshot,
        streamUrl: new URL(DEVICE_STREAM_PATH, config.cloudWorkspaces.setupExecution.engineUplinkEndpoint).toString(),
        workosEnabled: config.auth.provider === "workos" } }
    : {}),
  ...(cloudWorkspaceAccessService ? { cloudWorkspaceAccessService } : {}),
  ...(cloudWorkspaceProviderResolver ? { cloudWorkspaceProviderResolver } : {}),
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
  ...(cloudCapabilities ? { cloudCapabilities } : {}),
  // The relay route joins once realtime serves /v1/relay.
  ...(cloudCapabilities ? { cloudRuntimeConnect: { capabilities: cloudCapabilities, cloudWorkspaces: config.cloudWorkspaces,
    ...(cloudDirectRoute ? { direct: cloudDirectRoute } : {}) } } : {}),
});

let shuttingDown = false;
const server = serve({ fetch: app.fetch, port: config.port, ...(config.host ? { hostname: config.host } : {}) }, (info) => {
  if (shuttingDown) return;
  if(migrationResult.status.state==="current"){
    if (cloudGithubWriteCleanup || cloudGithubReads) {
      const sweep = () => {
        if (githubWriteCleanupRunning) return;
        githubWriteCleanupRunning = true;
        // DB expiry belongs to workers. The read broker's credential/cache
        // cleanup is process-local, so each API keeps its own timer.
        githubWriteCleanupPending = Promise.all([cloudGithubWriteCleanup?.cleanup(), cloudGithubReads?.cleanup()])
          .then(() => undefined).catch(() => undefined).finally(() => { githubWriteCleanupRunning = false; });
      };
      sweep();
      githubWriteCleanup = setInterval(sweep, 30_000);
      githubWriteCleanup.unref();
    }
    startCloudBackground();
    startCloudHealthAlerts();
    if (workerPool) {
      const securityPublisher = new SecurityEventPublisher(workerPool, console, workerPollingOptions(config.workerPollIntervalsMs, "security"));
      stopSecurityEventPublisher = securityPublisher.start();
      workerNotifications.security = () => securityPublisher.notify();
      if (workosSync) workerNotifications.workos = () => workosSync.notify();
      // Security/directory publication also runs with cloud disabled. One
      // shared session per process serves the handlers that actually started.
      stopCloudWorkerNotifications = startCloudWorkerNotifications(listenerPool, workerNotifications);
    }
  }
  console.log(`[control-plane] listening on :${info.port}`);
});
if (servesApi && cloudWorkspaceAccessService && migrationResult.status.state !== "controlled_migration_pending") {
  const access = cloudWorkspaceAccessService;
  cloudPreviewWebSocketRelay = new CloudPreviewWebSocketRelay({
    recognizes: request => access.recognizesPreviewRequest(request),
    resolve: request => access.resolvePreviewWebSocket(request),
    revalidate: (request, grant) => access.revalidatePreviewWebSocket(request, grant),
  });
}
// The S2 engine uplink is served by realtime and combined processes once the
// capability authority supplies keys, epochs and engine tokens; each
// organization is admitted only while its `realtime_uplink` flag is on. The
// capability authority mounts once the first flag load shows `capabilities`
// on for any organization (and again if a later change turns it on), so a
// flags-off deployment never mounts the socket.
let cloudEngineUplink: CloudEngineUplinkServer | undefined;
let uplinkPresence: UplinkPresenceWriter | undefined;
let uplinkCheckpointPush: UplinkCheckpointPush | undefined;
let stopUplinkNotifications: () => Promise<void> = async () => {};
// One security-event feed per realtime process, shared by the device stream
// and the S1 revocation producer (auth.epochs to owned uplinks,
// capability.revoked to device streams), started by whichever mounts first.
let realtimeSecurityEvents: DatabaseRealtimeSecurityEventFeed | undefined;
let capabilityRevocationPush: CapabilityRevocationPush | undefined;
let uplinkAuthSource: ReturnType<typeof uplinkCapabilityAuthority> = null;
const sharedSecurityEvents = () => {
  realtimeSecurityEvents ??= new DatabaseRealtimeSecurityEventFeed(new DatabaseSecurityEventSource(pool), { listenerPool });
  void realtimeSecurityEvents.start();
  return realtimeSecurityEvents;
};
const startCapabilityRevocationPush = () => {
  if (capabilityRevocationPush || !rolloutFlagSnapshot) return;
  capabilityRevocationPush = new CapabilityRevocationPush({
    feed: sharedSecurityEvents(), source: new DatabaseCapabilityRevocationSource(pool), flags: rolloutFlagSnapshot,
    uplink: () => cloudEngineUplink && uplinkAuthSource ? { server: cloudEngineUplink, auth: uplinkAuthSource.source } : null,
    deviceStreams: () => deviceStream,
  });
};
const mountEngineUplink = () => {
  if (cloudEngineUplink || shuttingDown) return;
  if (processRole !== "realtime" && processRole !== "combined") return;
  const uplinkAuth = uplinkCapabilityAuthority({
    pool, keyStore: capabilityKeyStore,
    issuer: config.cloudWorkspaces?.capabilityIssuer ?? null, flags: rolloutFlagSnapshot,
  });
  if (!uplinkAuth || !rolloutFlagSnapshot || migrationResult.status.state !== "current") return;
  const presenceStore = new DatabaseUplinkPresenceStore(pool);
  const alerts = new AuditUplinkSecurityAlerts({ pool });
  uplinkPresence = new UplinkPresenceWriter(presenceStore);
  // Credential-control push (S2 cred channel): the binding's desired
  // revision is read at the gate and on every notified bump. The engine's
  // exchange re-reads authority; the notification is only a hint. The table
  // is RLS-hidden from the runtime role, so the read goes through the
  // system-statement store.
  const uplinkCredStore = new DatabaseUplinkCredentialStore(pool);
  const uplinkCredPush = new UplinkCredentialPush({
    sessionFor: engineInstanceId => cloudEngineUplink?.session(engineInstanceId) ?? null,
    readRevision: identity => uplinkCredStore.desiredRevision(identity.engineInstanceId),
    readRevisions: engineInstanceIds => uplinkCredStore.desiredRevisions(engineInstanceIds),
  });
  // Checkpoint-request push (S2 checkpoint channel): a timing hint only;
  // the engine's heartbeat still delivers and fences the directive.
  const uplinkCheckpointStore = new DatabaseUplinkCheckpointStore(pool);
  const checkpointPush = new UplinkCheckpointPush({
    readQueued: identities => uplinkCheckpointStore.queued(identities),
    notificationsCurrent: () => cloudEngineUplink?.notificationsCurrent === true,
  });
  uplinkCheckpointPush = checkpointPush;
  cloudEngineUplink = new CloudEngineUplinkServer({
    authority: new DatabaseUplinkAuthority({ pool, workosEnabled: config.auth.provider === "workos", alerts }),
    lease: new DatabaseUplinkLeaseStore({ pool, workosEnabled: config.auth.provider === "workos" }),
    idle: new DatabaseUplinkIdleStopStore(new DatabaseCloudIdleStop(pool, config.auth.provider === "workos")),
    authSource: uplinkAuth.source,
    capabilities: uplinkAuth.issuer,
    flags: rolloutFlagSnapshot,
    realtimeInstance: realtimeInstanceId(),
    presence: uplinkPresence,
    alerts,
    extensions: [uplinkCredPush, checkpointPush, new UplinkTurnJournal({ store: new DatabaseUplinkTurnStore(pool) })],
  });
  uplinkAuthSource = uplinkAuth;
  startCapabilityRevocationPush();
  const stopNotifications = startUplinkNotifications(listenerPool, cloudEngineUplink, presenceStore, console, uplinkCredPush, checkpointPush);
  stopUplinkNotifications = async () => {
    capabilityRevocationPush?.stop();
    await Promise.allSettled([stopNotifications(), realtimeSecurityEvents?.stop()]);
  };
};
void rolloutFlagsStarted?.then(mountEngineUplink);
rolloutFlagSnapshot?.onChange(mountEngineUplink);
// The S3 device stream is served by realtime and combined processes once any
// organization has `device_stream` on; until then no feed, LISTEN or socket
// exists and clients keep polling. Access is re-evaluated on the process's
// security-event feed and workspace catalog notifications.
let deviceStream: DeviceStreamServer | undefined;
let deviceStreamSecurityEvents: DatabaseRealtimeSecurityEventFeed | undefined;
let stopDeviceStreamNotifications: () => Promise<void> = async () => {};
const mountDeviceStream = () => {
  if (deviceStream || shuttingDown) return;
  if (processRole !== "realtime" && processRole !== "combined") return;
  if (!rolloutFlagSnapshot || migrationResult.status.state !== "current" || !rolloutFlagSnapshot.anyEnabled("device_stream")) return;
  deviceStreamSecurityEvents = sharedSecurityEvents();
  deviceStream = new DeviceStreamServer({
    authority: new DatabaseDeviceSessionAuthority(pool),
    catalog: new DatabaseDeviceStreamCatalogSource(pool, config.cloudWorkspaces ?? null),
    flags: rolloutFlagSnapshot,
    securityEvents: deviceStreamSecurityEvents,
  });
  startCapabilityRevocationPush();
  stopDeviceStreamNotifications = startDeviceStreamNotifications(listenerPool, deviceStream);
};
void rolloutFlagsStarted?.then(mountDeviceStream);
rolloutFlagSnapshot?.onChange(mountDeviceStream);
server.on("upgrade", (request, socket, head) => {
  if (!servesApi || shuttingDown || migrationResult.status.state !== "current") { socket.destroy(); return; }
  if (cloudEngineUplink?.handleUpgrade(request, socket, head)) return;
  if (deviceStream?.handleUpgrade(request, socket, head)) return;
  if (cloudRuntimeServiceRelay?.handleUpgrade(request, socket, head)) return;
  if (cloudPreviewWebSocketRelay?.handleUpgrade(request, socket, head)) return;
  if (!cloudRuntimeBridge?.handleUpgrade(request, socket, head)) socket.destroy();
});

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopGithubCleanup();
  if (githubWriteCleanup) clearInterval(githubWriteCleanup);
  const drainMs = config.shutdownDrainMs ?? 0;
  console.log(`[control-plane] ${signal}; draining${drainMs ? ` sessions over ${drainMs}ms` : ""}`);
  const backgroundStopped = Promise.allSettled([
    stopCloudWorkerNotifications(),
    stopCloudCheckpointHintNotifications(),
    cloudGithubReads?.close(),
    githubWriteCleanupPending,
    stopCloudSetupWorker(),
    stopCloudComputerRetirementWorker(),
    stopCloudComputerTemplateWorker(),
    stopCloudRuntimeQualificationWorker(),
    stopCloudRuntimeImageWorker(),
    stopCloudRuntimeStagingWorker(),
    stopCloudComputerTemplateRetentionWorker(),
    stopCloudAccessRevocationWorker(),
    stopCloudCheckpointRequestWorker(),
    stopCloudForkWorker(),
    stopCloudObjectMaintenanceWorker(),
    stopCloudOperationsWorker(),
    stopCloudOutboxWorker(),
    stopCloudInvitationWorker(),
    stopCloudHealthAlerts(),
    stopCloudReconciler(),
    stopCloudProAllowances(),
    workosSync?.stop() ?? Promise.resolve(),
    securityEventBroker.stop(),
    stopSecurityEventPublisher(),
    rolloutFlagSnapshot?.stop(),
    engineAuthorityCache?.stop(),
    capabilityKeyStore?.stop(),
  ]);
  const deadline = setTimeout(() => process.exit(1), 15_000 + drainMs);
  deadline.unref();
  // Upgrades are refused from here on. With a drain window, open sessions
  // keep working and are told to reconnect gradually while the replacement
  // instance takes new ones; HTTP keeps serving until they are gone.
  if (drainMs > 0) {
    void Promise.allSettled([
      cloudRuntimeBridge?.drain(drainMs),
      cloudPreviewWebSocketRelay?.drain(drainMs),
      cloudRuntimeServiceRelay?.drain(drainMs),
      cloudEngineUplink?.drain(drainMs),
      deviceStream?.drain(drainMs),
    ]).then(() => closeServer(backgroundStopped, deadline));
  } else closeServer(backgroundStopped, deadline);
}

function closeServer(backgroundStopped: Promise<unknown>, deadline: ReturnType<typeof setTimeout>): void {
  cloudRuntimeBridge?.close();
  // Held engine hints would otherwise keep the server open past its exit deadline.
  closeCloudCheckpointHints();
  cloudPreviewWebSocketRelay?.close();
  cloudRuntimeServiceRelay?.close();
  cloudEngineUplink?.close();
  uplinkCheckpointPush?.close();
  // The uplink LISTEN outlives the drain: engines still on this instance keep
  // credential pushes and authority teardown until their uplink is closed.
  const uplinkNotificationsStopped = stopUplinkNotifications();
  deviceStream?.close();
  const deviceStreamStopped = Promise.allSettled([stopDeviceStreamNotifications(), deviceStreamSecurityEvents?.stop()]);
  server.close(() => {
    void Promise.allSettled([backgroundStopped, uplinkNotificationsStopped, deviceStreamStopped])
      .then(async () => {
        // A lost-uplink write that misses this window is overwritten by the
        // next owner's connect; until then its stale last_seen_at marks it.
        await uplinkPresence?.close(2_000);
        await shutdownControlPlaneTracing(2_000);
        const pools = new Set([pool, listenerPool]);
        if (workerPool) pools.add(workerPool);
        if (retirementLockPool) pools.add(retirementLockPool);
        await Promise.all([...pools].map(value => value.end()));
      })
      .finally(() => {
        clearTimeout(deadline);
        process.exit(0);
      });
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
