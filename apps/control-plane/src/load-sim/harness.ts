// The load simulator's in-process control plane: real services, real route
// factories, real background workers and a real PostgreSQL database. Only the
// Boat provider is fake (an in-memory inventory), and engines/desktop clients
// are simulated by calling the same service methods the internal and /v1
// routes call, at the cadences the real engine and desktop use.

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { ensureUser, resolveAuthenticatedUser, type AuthenticatedIdentityInput, type AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { createPool } from "../db.js";
import { SecurityEventPublisher } from "../security-events.js";
import { CloudWorkspaceAccessRevocationWorker } from "../cloud-workspaces/access.js";
import { DatabaseCloudAgentCredentialService } from "../cloud-workspaces/agent-credentials.js";
import { DatabaseCloudAgentExecutionService } from "../cloud-workspaces/agent-executions.js";
import { CloudAgentBootCredentialResponseSchema } from "../cloud-workspaces/agent-boot-contract.js";
import { CloudWorkspaceCheckpointRequestWorker } from "../cloud-workspaces/checkpoint-requests.js";
import { DatabaseCloudWorkspaceDurableRecordService } from "../cloud-workspaces/durable-record.js";
import { DatabaseCloudWorkspaceEngineClientAdmissionService } from "../cloud-workspaces/engine-client-admission.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "../cloud-workspaces/engine-protocol-version.js";
import { LIFECYCLE_JOB_KINDS } from "../cloud-workspaces/lifecycle-jobs.js";
import { runDueLifecycleJobs } from "../cloud-workspaces/lifecycle-job-test-utils.js";
import { claimJobs } from "../job-queue.js";
import { cloudRuntimeRelayLimits } from "../cloud-workspaces/runtime-bridge-limits.js";
import type { CloudProviderInventoryItem, CloudProviderResource, CloudWorkspaceAccessProvider, CloudWorkspaceProvider } from "../cloud-workspaces/provider.js";
import { CloudWorkspaceProviderRegistry } from "../cloud-workspaces/provider-registry.js";
import { DatabaseCloudWorkspaceProviderResolver } from "../cloud-workspaces/provider-resolver.js";
import { CloudWorkspaceReconciler } from "../cloud-workspaces/reconciler.js";
import { cloudWorkspaceDeviceProofMessage } from "../cloud-workspaces/replicas.js";
import { createCloudWorkspaceRoutes } from "../cloud-workspaces/routes.js";
import { DatabaseCloudWorkspaceSetupMaterialService } from "../cloud-workspaces/setup-materials.js";
import { computerTestAccount, computerTestWallet } from "../cloud-workspaces/computer-workspace-test-fixtures.js";
import { runtimeBase } from "../cloud-workspaces/runtime-test-fixtures.js";
import { seedReadyCloudWorkspace, withCloudFixtureOwnerTx, type ReadyCloudWorkspaceFixture } from "../cloud-workspaces/test-fixtures.js";
import { DatabaseCostMeter } from "./instrument.js";
import { AUTHORITY_CACHE_CHANNEL } from "../cloud-workspaces/engine-authority-cache.js";

const ORIGIN = "https://control.load-sim.test";
const ENGINE_PORT = 39393;
const quiet = { info() {}, warn() {}, error() {}, log() {} };

const cloudConfig: CloudWorkspaceBackendConfig = {
  provider: "boat",
  apiKey: "boat-api-key-for-load-simulation",
  apiUrl: "https://api.load-sim.test",
  target: "eu",
  snapshotId: runtimeBase.imageRef,
  imageRef: runtimeBase.imageRef,
  architecture: "linux/amd64",
  cpuMillicores: 2_000,
  memoryMiB: 4_096,
  storageMiB: 20_480,
  sourceCommit: "a".repeat(40),
  operationTimeoutSeconds: 30,
  autoArchiveMinutes: 10_080,
  reconcileIntervalMs: 60_000,
  settingsSecretEncryptionKeys: {},
  currentSettingsSecretEncryptionKeyVersion: null,
  settingsSecretKeyV1: null,
  access: {
    allowedSshHosts: ["ssh.load-sim.test"],
    allowedPreviewHostSuffixes: ["preview.load-sim.test"],
    previewBaseDomain: "cloud-preview.load-sim.test",
  },
  durability: null,
  outbox: null,
  setupExecution: null,
  runtime: { qualificationMode: "full" },
  boat: { accountScope: computerTestAccount, billingOrg: computerTestWallet, ttlSeconds: 1800 },
  bridge: cloudRuntimeRelayLimits({}),
};

/** An in-memory Boat: every seeded workspace has one running sandbox. */
export class FakeBoatProvider implements CloudWorkspaceProvider, CloudWorkspaceAccessProvider {
  readonly name = "boat";
  readonly calls = new Map<string, number>();
  private readonly resources = new Map<string, CloudProviderResource>();

  add(workspaceId: string): void {
    const resourceId = `sandbox-${workspaceId}`;
    this.resources.set(resourceId, { resourceId, state: "running", target: "eu", workspaceId, generation: 1, metadata: {} });
  }

  private count(name: string): void {
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
  }

  async find(identity: { workspaceId: string; generation: number }) {
    this.count("find");
    return [...this.resources.values()].filter(row => row.workspaceId === identity.workspaceId && row.generation === identity.generation);
  }
  async create(): Promise<CloudProviderResource> { this.count("create"); throw new Error("load simulator never creates sandboxes"); }
  async inspect(id: string) { this.count("inspect"); return this.resources.get(id) ?? null; }
  async start(id: string) { this.count("start"); return this.resources.get(id)!; }
  async stop(id: string) { this.count("stop"); return { ...this.resources.get(id)!, state: "stopped" as const }; }
  async archive(id: string) { this.count("archive"); return { ...this.resources.get(id)!, state: "archived" as const }; }
  async delete(id: string) { this.count("delete"); this.resources.delete(id); }
  async *listManaged() { this.count("listManaged"); yield* this.resources.values(); }
  /** The real provider pages GET /sandboxes at 100 per request. */
  async *listInventory(): AsyncIterable<CloudProviderInventoryItem> {
    const all = [...this.resources.values()];
    for (let offset = 0; offset === 0 || offset < all.length; offset += 100) {
      this.count("listInventoryPage");
      for (const resource of all.slice(offset, offset + 100))
        yield { resourceId: resource.resourceId, state: resource.state,
          computeStopped: resource.computeStopped === true,
          workspaceId: resource.workspaceId, generation: resource.generation };
    }
  }
  async createSshAccess(): Promise<never> { throw new Error("load simulator never creates SSH access"); }
  async revokeSshAccess() { this.count("revokeSshAccess"); }
  async getPreviewEndpoint(): Promise<never> { throw new Error("load simulator never opens previews"); }
}

export type SimulatedWorkspace = {
  fixture: ReadyCloudWorkspaceFixture;
  engine: { organizationId: string; workspaceId: string; generation: number; engineInstanceId: string; heartbeatToken: string };
  bootId: string;
  writerEpoch: string;
  actorSessionId: string;
  grantToken: string;
  user: AuthedUser;
  identity: AuthenticatedIdentityInput;
};

export type SimulatorOperation = (workspace: SimulatedWorkspace) => Promise<unknown>;

export type Simulator = Awaited<ReturnType<typeof createSimulator>>;

/** The simulator writes through the database's owner credentials when it
 * seeds. Callers own the database; this module never resets it. */
export async function createSimulator(options: { databaseUrl: string; meter: DatabaseCostMeter; workosEnabled?: boolean }) {
  const { meter, databaseUrl } = options;
  const workosEnabled = options.workosEnabled ?? true;
  const rawApi = createPool(databaseUrl, { workload: "api", applicationName: "zeros-load-sim-api" });
  const rawWorker = createPool(databaseUrl, { workload: "worker", applicationName: "zeros-load-sim-worker" });
  const seed = new pg.Pool({ connectionString: databaseUrl, max: 4, application_name: "zeros-load-sim-seed" });
  // Job-queue wake-ups and authority-cache hints are NOTIFYs issued by
  // database triggers, invisible to client instrumentation; count deliveries
  // on their channels instead. Identical job notifications dedupe per
  // transaction, so job deliveries equal notifying commits on that channel.
  // One commit can carry several authority scopes (w:, o:, u:), so those
  // deliveries are an upper bound on its notifying commits.
  const notifications = { count: 0, authorityCache: 0 };
  const listener = new pg.Client({ connectionString: databaseUrl, application_name: "zeros-load-sim-listen" });
  await listener.connect();
  listener.on("notification", message => {
    if (message.channel === AUTHORITY_CACHE_CHANNEL) notifications.authorityCache += 1;
    else notifications.count += 1;
  });
  await listener.query(`LISTEN zeros_control_plane_job_work; LISTEN ${AUTHORITY_CACHE_CHANNEL}`);
  const api = meter.instrument(rawApi);
  const worker = meter.instrument(rawWorker);
  const boat = new FakeBoatProvider();
  const registry = new CloudWorkspaceProviderRegistry([{ name: "boat", hosted: { provider: boat } }]);
  const apiResolver = new DatabaseCloudWorkspaceProviderResolver({ pool: api, workosEnabled, registry });
  const workerResolver = new DatabaseCloudWorkspaceProviderResolver({ pool: worker, workosEnabled, registry });
  const keys = { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } };
  const materials = new DatabaseCloudWorkspaceSetupMaterialService({
    pool: api,
    setupAudience: `${ORIGIN}/internal/v1/cloud-workspaces/setup/admission`,
    engineRegistrationAudience: `${ORIGIN}/internal/v1/cloud-workspaces/engine/register`,
    engineHeartbeatAudience: `${ORIGIN}/internal/v1/cloud-workspaces/engine/heartbeat`,
    engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
    enginePort: ENGINE_PORT,
    setupSecretKeyV1: randomBytes(32).toString("base64url"),
    github: {
      mintContentsRead: async () => ({ token: "ghs_load_simulation", expiresAtMs: Date.now() + 3_600_000 }),
      mint: async () => ({ token: "ghs_load_simulation", expiresAtMs: Date.now() + 3_600_000 }),
      revoke: async () => {},
    },
    accountIdentityProvider: "workos",
    accountAuth: {
      jwksUrl: "https://identity.load-sim.test/.well-known/jwks.json",
      audience: "https://api.load-sim.test",
      issuers: ["https://identity.load-sim.test/"],
      contract: "zeros-access-v1",
      clientId: "client_desktop_load_sim",
    },
  });
  const records = new DatabaseCloudWorkspaceDurableRecordService({ pool: api, workosEnabled });
  const executions = new DatabaseCloudAgentExecutionService(api, keys, workosEnabled);
  const seedExecutions = new DatabaseCloudAgentExecutionService(seed, keys, workosEnabled);
  const credentials = new DatabaseCloudAgentCredentialService(seed, keys);
  const admission = new DatabaseCloudWorkspaceEngineClientAdmissionService({
    pool: api, endpoint: `${ORIGIN}/internal/v1/cloud-workspaces/engine/client-admission`,
    enginePort: ENGINE_PORT, workosEnabled, relayEnabled: true,
  });
  const seedAdmission = new DatabaseCloudWorkspaceEngineClientAdmissionService({
    pool: seed, endpoint: `${ORIGIN}/internal/v1/cloud-workspaces/engine/client-admission`,
    enginePort: ENGINE_PORT, workosEnabled, relayEnabled: true,
  });
  const reconciler = new CloudWorkspaceReconciler({
    pool: worker, provider: boat, providerResolver: workerResolver, workosEnabled, logger: quiet,
  });

  // /v1 requests re-resolve the account from its verified claims on every
  // request, exactly as createAuthMiddleware does after JWT verification.
  const identities = new Map<string, AuthenticatedIdentityInput>();
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: { code: error.code } }, error.status);
    throw error;
  });
  app.use("/v1/*", async (c, next) => {
    const identity = identities.get(c.req.header("x-load-sim-user") ?? "");
    if (!identity) return c.json({ error: { code: "unauthorized" } }, 401);
    c.set("user", await meter.run("client.auth", () => resolveAuthenticatedUser(api, identity)));
    await next();
  });
  app.route("/", createCloudWorkspaceRoutes(api, cloudConfig, {
    workosEnabled, engineClientAdmissionService: admission, providerResolver: apiResolver,
  }));

  const workspaces: SimulatedWorkspace[] = [];
  let qualified = false;

  async function seedWorkspace(): Promise<SimulatedWorkspace> {
    const fixture = await seedReadyCloudWorkspace(seed);
    boat.add(fixture.workspaceId);
    await seed.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1", [fixture.engineInstanceId]);
    await withCloudFixtureOwnerTx(seed, async tx => {
      if (workosEnabled) {
        await tx.query("INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state) VALUES($1,$2,$3,'active')",
          [fixture.organizationId, `org_${randomUUID()}`, fixture.organizationId]);
      }
      if (!qualified) {
        // Positive qualification evidence is installed only by the database owner.
        await tx.query("SET LOCAL session_replication_role=replica");
        await tx.query("UPDATE cloud_runtime_qualifications SET native_capabilities=$1::jsonb WHERE credential_kind='cursor-api-key'",
          [JSON.stringify({ version: 1, goals: false, nativeFork: false, transcriptFork: false, nativeReview: false, connectedApps: false, multiAgent: false })]);
      }
    });
    qualified = true;
    const credentialId = randomUUID();
    await credentials.put({ credentialId, ownerUserId: fixture.userId, organizationId: fixture.organizationId, operationId: randomUUID(),
      expectedRevision: 0, displayName: "Load simulation Cursor", material: { kind: "cursor-api-key", apiKey: "synthetic-load-sim-cursor-key" } });
    await credentials.setOrganizationConnection(fixture.userId, fixture.organizationId, "cursor", { expectedRevision: 0, credentialId,
      credentialRevision: 1, models: ["grok-4.6"], consent: "zeros-managed" });
    const engine = { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1,
      engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken };
    const request = { version: 1, mode: "boot-owner-v1", organizationId: fixture.organizationId, workspaceId: fixture.workspaceId,
      generation: 1, engineInstanceId: fixture.engineInstanceId };
    const bound = CloudAgentBootCredentialResponseSchema.parse(await seedExecutions.boot(engine, "bootstrap", request));
    await seedExecutions.boot(engine, "activate", { ...request, bootId: bound.bootId, writerEpoch: bound.writerEpoch,
      expectedCacheRevision: bound.cacheRevision });

    const now = Math.floor(Date.now() / 1000);
    const identity: AuthenticatedIdentityInput = {
      provider: "workos", providerSubject: `workos|${fixture.userId}`, email: `durable-${fixture.userId}@example.test`,
      displayName: "Durable Workspace Owner",
      session: { id: `session_${randomUUID()}`, clientKind: "desktop", authTime: now, tokenExpiresAt: now + 6 * 3600 },
    };
    const user = await ensureUser(seed, identity);
    await seed.query("INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES($1,$2,$3,'desktop',now()+interval '6 hours') ON CONFLICT DO NOTHING",
      [user.authentication.sessionId, user.identity.subject, user.id]);
    const pair = generateKeyPairSync("ed25519");
    const publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url");
    const device = (await seed.query<{ id: string }>("INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Load simulation','macos',$2,$3) RETURNING id",
      [user.id, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0]!;
    const fields = { deviceId: device.id, keyVersion: 1, timestampMs: Date.now(), nonce: randomBytes(24).toString("base64url") };
    const proof = { ...fields, signature: sign(null, cloudWorkspaceDeviceProofMessage({ ...fields, accountUserId: user.id, action: "engine.connect",
      payload: { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId } }), pair.privateKey).toString("base64url") };
    const grant = await seedAdmission.issueActor({ organizationId: fixture.organizationId, workspaceId: fixture.workspaceId,
      actorUserId: user.id, proof, authenticatedUser: user });
    const consumed = await seedAdmission.consumeActor({ ...engine, token: grant.grantToken });
    identities.set(user.id, identity);
    const workspace = { fixture, engine, bootId: bound.bootId, writerEpoch: bound.writerEpoch,
      actorSessionId: consumed.actorSessionId, grantToken: grant.grantToken, user, identity };
    workspaces.push(workspace);
    return workspace;
  }

  const request = (w: SimulatedWorkspace) => ({ version: 1, mode: "boot-owner-v1", organizationId: w.engine.organizationId,
    workspaceId: w.engine.workspaceId, generation: 1, engineInstanceId: w.engine.engineInstanceId, bootId: w.bootId, writerEpoch: w.writerEpoch });

  /** Each entry is one request the real engine, desktop or worker issues. */
  const operations = {
    "engine.heartbeat": (w: SimulatedWorkspace) => materials.heartbeat({ workspaceId: w.engine.workspaceId,
      organizationId: w.engine.organizationId, generation: 1, engineInstanceId: w.engine.engineInstanceId,
      token: w.engine.heartbeatToken, observedPorts: [] }),
    "engine.durableRecordHead": (w: SimulatedWorkspace) => records.headForEngine({ ...w.engine, afterEntityKind: null, afterEntityId: null }),
    "engine.credentialControls": (w: SimulatedWorkspace) => executions.credentialControls(w.engine, { ...request(w), acknowledgements: [] }),
    "engine.actorConfirm": (w: SimulatedWorkspace) => executions.boot(w.engine, "actor-confirm", { ...request(w), actorSessionId: w.actorSessionId }),
    "client.renew": (w: SimulatedWorkspace) => admission.consumeActor({ ...w.engine, token: w.grantToken, renew: true }),
    "client.relayRevalidate": async (w: SimulatedWorkspace) => {
      if (!await admission.authorizeRelay(w.grantToken, { connected: true })) throw new Error("relay revalidation was refused");
    },
    "client.catalog": async (w: SimulatedWorkspace) => {
      const response = await app.request("/v1/cloud-workspaces?limit=100", { headers: { "x-load-sim-user": w.user.id } });
      if (response.status !== 200) throw new Error(`catalog returned ${response.status}`);
      await response.arrayBuffer();
    },
    "provider.resolve": (w: SimulatedWorkspace) => apiResolver.resolve({ workspaceId: w.engine.workspaceId,
      organizationId: w.engine.organizationId, generation: 1, purpose: "lifecycle" }),
    // An idle replica's only lifecycle read: one claim over the job kinds.
    "worker.lifecycleJobClaim": () => claimJobs(worker, { owner: "load-sim", limit: 4,
      kinds: Object.values(LIFECYCLE_JOB_KINDS).map(kind => ({ kind, leaseMs: 60_000 })) }),
    "worker.reconcileOnce": () => reconciler.runOnce(),
    "worker.reconcileDrift": () => reconciler.reconcileDriftOnce(),
    "worker.reconcileOrphans": () => reconciler.reconcileOrphansOnce(),
    // One engine-health job run: claim, due read, lease check, exact reschedule.
    "worker.engineHealthJob": () => runDueLifecycleJobs(worker, reconciler, ["engineHealth"]),
    // One hourly maintenance pass: six DUE scans plus the failed-job purge.
    "worker.jobAudit": () => reconciler.auditJobs(),
  } satisfies Record<string, SimulatorOperation>;

  /** Untimed, unattributed setup that makes the next measured call do real work. */
  const prepare: Partial<Record<keyof typeof operations, (workspace: SimulatedWorkspace) => Promise<unknown>>> = {
    // A running workspace becomes drift-due once its last observation is older
    // than the reconciler interval; measure that due check, not an empty scan.
    "worker.reconcileDrift": w => seed.query(`UPDATE cloud_workspace_provider_bindings
      SET last_observed_at=now()-interval '10 minutes', next_drift_check_at=now()-interval '1 second' WHERE workspace_id=$1`,
      [w.engine.workspaceId]),
    // Steady state: the heartbeat renewed the lease before the job ran, so the
    // run reschedules at the new expiry instead of stopping the engine.
    "worker.engineHealthJob": async w => {
      await seed.query(`UPDATE cloud_workspace_engine_instances SET lease_expires_at=now()+interval '90 seconds' WHERE id=$1`,
        [w.engine.engineInstanceId]);
      // A previous claim probe may still hold the row as running; release it
      // due now so every iteration measures the full claim→run→complete cycle.
      await seed.query(`UPDATE control_plane_jobs
        SET state='queued', run_at=now(), lease_owner=NULL, lease_token=NULL, locked_until=NULL
        WHERE kind='cloud_engine_health' AND dedupe_key=$1`,
        [`workspace:${w.engine.workspaceId}`]);
    },
  };

  /** Production's idle background workers that need no external service. */
  function startBackgroundWorkers(): () => Promise<void> {
    const stops = [
      meter.run("background.reconciler", () => new CloudWorkspaceReconciler({ pool: worker, provider: boat,
        providerResolver: workerResolver, workosEnabled, logger: quiet }).start()),
      meter.run("background.accessRevocation", () => new CloudWorkspaceAccessRevocationWorker({ pool: worker,
        providerResolver: workerResolver, leaseMs: 60_000, logger: quiet }).start()),
      meter.run("background.checkpointRequests", () => new CloudWorkspaceCheckpointRequestWorker(worker, { logger: quiet }).start()),
      meter.run("background.securityEvents", () => new SecurityEventPublisher(worker, quiet).start()),
    ];
    return async () => { await Promise.all(stops.map(stop => stop())); };
  }

  return {
    meter,
    boat,
    workspaces,
    operations,
    prepare,
    seedWorkspace,
    startBackgroundWorkers,
    seedPool: seed,
    /** The instrumented pools every simulated service uses. */
    pools: { api, worker },
    /** Job-channel notifications delivered so far (one per notifying commit)
     * and authority-cache hints (at least one per notifying commit). */
    notifications,
    async close() {
      listener.removeAllListeners();
      await listener.end().catch(() => {});
      await Promise.all([rawApi.end(), rawWorker.end(), seed.end()]);
    },
  };
}

export type SimulatorOperationName = keyof Simulator["operations"];
