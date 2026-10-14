import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const api = { query: vi.fn(), connect: vi.fn(), end: vi.fn(async () => {}) };
  const worker = { query: vi.fn(), connect: vi.fn(), end: vi.fn(async () => {}) };
  const listener = { query: vi.fn(), connect: vi.fn(), end: vi.fn(async () => {}) };
  const retirementLock = { query: vi.fn(), connect: vi.fn(), end: vi.fn(async () => {}) };
  return { api, worker, listener, retirementLock, config: undefined as Config | undefined,
    instances: [] as { name: string; args: unknown[]; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[],
    app: vi.fn(() => ({ fetch: vi.fn() })), checkpoint: vi.fn(() => async () => {}),
    notifications: vi.fn(() => async () => {}), cleanup: vi.fn(() => () => {}),
    serve: vi.fn(), close: vi.fn((done: () => void) => done()), upgrade: vi.fn(),
    migrationState: "current", createPool: vi.fn(), readCleanup: vi.fn(async () => {}),
    writeCleanup: vi.fn(async () => {}), securityStop: vi.fn(async () => {}),
  };
});

function component(name: string, args: unknown[]) {
  const stop = vi.fn(async () => {});
  const value = { name, args, start: vi.fn(() => stop), stop, notify: vi.fn(),
    enqueue: vi.fn(), read: vi.fn(), close: vi.fn(), handleUpgrade: vi.fn(() => false) };
  state.instances.push(value);
  return value;
}
function stubClass(name: string) {
  return class { constructor(...args: unknown[]) { return component(name, args); } };
}
function instance(name: string) {
  const found = state.instances.find(value => value.name === name);
  if (!found) throw new Error(`Missing fixture ${name}`);
  return found;
}
function started() { return state.instances.filter(value => value.start.mock.calls.length); }

vi.mock("./config.js", async original => ({
  ...(await original<typeof import("./config.js")>()), loadConfig: () => state.config!,
}));
vi.mock("./db.js", async original => ({
  ...(await original<typeof import("./db.js")>()), createPool: state.createPool,
}));
vi.mock("./migrate.js", async original => ({
  ...(await original<typeof import("./migrate.js")>()), verifyMigrations: async () => ({
    ran: [], status: { state: state.migrationState, migration: "fixture", dependentRuntime: "fixture" },
  }),
}));
vi.mock("./app.js", () => ({ createApp: state.app }));
vi.mock("./email.js", () => ({ loadEmailConfig: () => ({ apiKey: "synthetic", from: "fixture@example.test" }), sendEmailStrict: vi.fn() }));
vi.mock("./github.js", () => ({ startGithubOauthCleanup: state.cleanup }));
vi.mock("@hono/node-server", () => ({ serve: state.serve }));
vi.mock("./cloud-workspaces/worker-notifications.js", () => ({ startCloudWorkerNotifications: state.notifications }));
vi.mock("./cloud-workspaces/engine-checkpoint-hints.js", () => ({
  CloudEngineCheckpointHints: class { wait() {} close() {} }, startCloudEngineCheckpointHintNotifications: state.checkpoint,
}));
vi.mock("./security-events.js", () => ({
  PostgresSecurityEventBroker: class { stop = state.securityStop; },
  SecurityEventPublisher: class { constructor(...args: unknown[]) { return component("security", args); } },
}));

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const fixtureKey = randomBytes(32).toString("base64url");
let oldTerm: ReturnType<typeof process.listeners>, oldInt: ReturnType<typeof process.listeners>;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); state.instances.length = 0; state.migrationState = "current";
  oldTerm = process.listeners("SIGTERM"); oldInt = process.listeners("SIGINT");
  const { loadConfig } = await vi.importActual<typeof import("./config.js")>("./config.js");
  state.config = loadConfig({ DATABASE_URL: "postgres://fixture@localhost/test_cloud_pools", DATABASE_MIGRATIONS_ON_BOOT: "false",
    AUTH0_DOMAIN: "identity.example.test", AUTH_AUDIENCE: "https://api.example.test", ZEROS_SELF_HOSTED: "true",
    RAILWAY_ENVIRONMENT_NAME: "alpha", GITHUB_APP_ID: "123456", GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_CLIENT_SECRET: "synthetic", GITHUB_APP_SLUG: "fixture", GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_OAUTH_CALLBACK_URL: "https://api.example.test/v1/github/oauth/callback",
    CLOUD_WORKSPACES_ENABLED: "true", CLOUD_WORKSPACE_PROVIDER: "boat", BOAT_API_KEY: "synthetic-not-a-live-key",
    BOAT_ACCOUNT_SCOPE: "fixture", BOAT_BILLING_ORG: "team_00000000-0000-4000-8000-000000000000",
    BOAT_SNAPSHOT_ID: "fixture", BOAT_IMAGE_BUILD_SHA256: "b".repeat(64), BOAT_TTL_SECONDS: "900",
    BOAT_COMPUTE_POLICY_ID: "fixture", BOAT_SECONDS_PER_DOLLAR: "3600", CLOUD_WORKSPACE_STORAGE_MIB: "20480",
    ZEROS_CLOUD_SOURCE_COMMIT: "a".repeat(40), CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "true",
    CLOUD_WORKSPACE_CONTROL_PLANE_URL: "https://api.example.test", CLOUD_WORKSPACE_SECRET_KEY_V1: fixtureKey,
    CLOUD_WORKSPACE_OBJECT_KEY_V1: fixtureKey, CLOUD_WORKSPACE_OBJECT_STORE_DIRECTORY: "/tmp/unused-pool-fixture",
    OPERATIONS_ALERT_EMAIL: "ops@example.test" });
  state.createPool.mockImplementation((_url, options) => options.workload === "worker" ? state.worker :
    options.workload === "retirement-lock" ? state.retirementLock :
    options.workload === "listener" || options.applicationName === "zeros-notifications" ? state.listener : state.api);
  state.serve.mockImplementation((_options, ready) => {
    ready({ port: 8080 }); return { on: state.upgrade, close: state.close };
  });
  for (const pool of [state.api, state.worker, state.listener, state.retirementLock]) {
    pool.query.mockImplementation(() => { throw new Error("Unexpected fixture query"); });
    pool.connect.mockImplementation(() => { throw new Error("Unexpected fixture acquisition"); });
  }
  const modules = [
    ["runtime-transfer", "DatabaseCloudRuntimeTransitionService"], ["computer-v2", "DatabaseCloudComputerV2Service"],
    ["provider-resolver", "DatabaseCloudWorkspaceProviderResolver"], ["setup-worker", "CloudWorkspaceSetupWorker"],
    ["linux-setup-executor", "CloudWorkspaceLinuxSetupExecutor"], ["setup-admission-broker", "DatabaseCloudWorkspaceSetupAdmissionBroker"],
    ["access", "CloudWorkspaceAccessRevocationWorker"], ["checkpoint-requests", "CloudWorkspaceCheckpointRequestWorker"],
    ["forks", "CloudWorkspaceForkWorker"], ["operations", "CloudWorkspaceOperationsWorker"],
    ["object-maintenance", "CloudWorkspaceObjectMaintenanceWorker"], ["outbox", "CloudWorkspaceOutboxWorker"],
    ["health-alerts", "CloudWorkspaceHealthAlertWorker"], ["pro-allowance", "DatabaseProMonthlyAllowance"],
    ["computer-template-retention", "CloudComputerTemplateRetentionWorker"], ["object-store", "DatabaseCloudWorkspaceBlobService"],
  ];
  for (const [file, name] of modules) vi.doMock(`./cloud-workspaces/${file}.js`, async () => ({
    ...(await vi.importActual(`./cloud-workspaces/${file}.js`)), [name!]: stubClass(name!),
  }));
  for (const [file, name] of [["runtime-qualification", "createRuntimeQualificationWorker"],
    ["runtime-images", "createRuntimeImageWorker"], ["runtime-staging", "createCloudRuntimeStagingWorker"],
    ["computer-template-worker-factory", "createComputerTemplateWorker"], ["computer-retirement", "createCloudComputerRetirementWorker"]]) {
    vi.doMock(`./cloud-workspaces/${file}.js`, async () => ({
      ...(await vi.importActual(`./cloud-workspaces/${file}.js`)), [name!]: (...args: unknown[]) => component(name!, args),
    }));
  }
  vi.doMock("./cloud-workspaces/provider-deployment.js", () => ({ createCloudProviderDeployment: (pool: unknown) => ({
    provider: { name: "boat", pool }, registry: { pool },
  }) }));
  vi.doMock("./cloud-workspaces/reconciler.js", () => ({ startCloudWorkspaceReconciler: (...args: unknown[]) => {
    const worker = component("lifecycle", args); worker.start(); return { stop: worker.stop, reconciler: worker };
  } }));
  vi.doMock("./cloud-workspaces/github-write-grants.js", async () => ({
    ...(await vi.importActual("./cloud-workspaces/github-write-grants.js")),
    DatabaseCloudGithubWriteGrants: class { constructor(readonly pool: unknown) {} cleanup() { state.writeCleanup(this.pool); } },
  }));
  vi.doMock("./cloud-workspaces/github-read-proxy.js", () => ({ DatabaseCloudGithubReads: class {
    constructor(readonly pool: unknown) {} cleanup() { state.readCleanup(this.pool); } close() {}
  } }));
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const handler of process.listeners("SIGTERM")) if (!oldTerm.includes(handler)) process.removeListener("SIGTERM", handler);
  for (const handler of process.listeners("SIGINT")) if (!oldInt.includes(handler)) process.removeListener("SIGINT", handler);
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe("cloud workload ownership", () => {
  it("starts no queue workers on an API replica and keeps only its local GitHub cache cleanup", async () => {
    state.config!.processRole = "api"; await import("./index.js");
    expect(started().map(value => value.name)).toEqual([]);
    expect(state.cleanup).not.toHaveBeenCalled(); expect(state.writeCleanup).not.toHaveBeenCalled();
    expect(state.readCleanup).toHaveBeenCalledWith(state.api);
    expect(state.checkpoint).toHaveBeenCalledOnce(); expect(state.notifications).not.toHaveBeenCalled();
    expect(state.createPool.mock.calls.some(call => call[1].workload === "retirement-lock")).toBe(false);
  });

  it("isolates nested provider, setup, Computer and blob dependencies from API saturation", async () => {
    await import("./index.js");
    expect(started().length).toBeGreaterThan(10);
    const options = (name: string) => instance(name).args[0] as { pool: unknown; providerResolver?: unknown; executor?: unknown };
    for (const name of ["CloudWorkspaceSetupWorker", "CloudWorkspaceAccessRevocationWorker", "CloudWorkspaceHealthAlertWorker", "lifecycle"])
      expect(options(name).pool, name).toBe(state.worker);
    for (const name of ["CloudWorkspaceCheckpointRequestWorker", "CloudWorkspaceForkWorker", "CloudWorkspaceOperationsWorker",
      "CloudComputerTemplateRetentionWorker", "DatabaseProMonthlyAllowance", "security"])
      expect(instance(name).args[0], name).toBe(state.worker);
    for (const name of ["createRuntimeImageWorker", "createCloudRuntimeStagingWorker", "createComputerTemplateWorker"])
      expect(instance(name).args[1], name).toBe(state.worker);
    const templateComputer = instance("createComputerTemplateWorker").args[4] as { args: unknown[] };
    expect(templateComputer.args[0]).toBe(state.worker);
    expect(instance("createCloudComputerRetirementWorker").args).toEqual([
      state.worker, state.config!.cloudWorkspaces, expect.objectContaining({ lockPool: state.retirementLock }),
    ]);
    const executor = options("CloudWorkspaceSetupWorker").executor as { args: { diagnosticPool: unknown; admissionBroker: { args: { pool: unknown }[] } }[] };
    expect(executor.args[0]!.diagnosticPool).toBe(state.worker);
    expect(executor.args[0]!.admissionBroker.args[0]!.pool).toBe(state.worker);
    const resolver = options("lifecycle").providerResolver as { args: { pool: unknown; registry: { pool: unknown } }[] };
    expect(resolver.args[0]!.pool).toBe(state.worker); expect(resolver.args[0]!.registry.pool).toBe(state.worker);
    const forkBlobs = instance("CloudWorkspaceForkWorker").args[1] as { args: { pool: unknown }[] };
    expect(forkBlobs.args[0]!.pool).toBe(state.worker);
    expect(state.writeCleanup).toHaveBeenCalledWith(state.worker); expect(state.readCleanup).toHaveBeenCalledWith(state.api);
    const qualifications = state.instances.filter(value => value.name === "createRuntimeQualificationWorker");
    expect(qualifications.filter(value => value.start.mock.calls.length).map(value => value.args[1])).toEqual([state.worker]);
    expect(state.checkpoint).toHaveBeenCalledExactlyOnceWith(state.listener, expect.anything());
    expect(state.notifications).toHaveBeenCalledExactlyOnceWith(state.listener, expect.anything());
  });

  it("does not create engine listeners or accept upgrades on the worker-only process", async () => {
    state.config!.processRole = "worker"; await import("./index.js");
    expect(state.checkpoint).not.toHaveBeenCalled(); expect(state.readCleanup).not.toHaveBeenCalled();
    expect(state.app.mock.calls[0]![1]).toBe(state.worker);
    expect(state.createPool.mock.calls.map(call => call[1].workload).sort()).toEqual(["listener", "retirement-lock", "worker"]);
    const socket = { destroy: vi.fn() };
    state.upgrade.mock.calls[0]![1]({}, socket, Buffer.alloc(0)); expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it.each(["combined", "worker"] as const)("drains queue work before ending every distinct pool exactly once (%s)", async role => {
    state.config!.processRole = role;
    await import("./index.js");
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    instance("CloudWorkspaceSetupWorker").stop.mockImplementation(() => pending);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const terminate = process.listeners("SIGTERM").find(handler => !oldTerm.includes(handler))!;
    terminate(); terminate(); await vi.advanceTimersByTimeAsync(0);
    expect(state.worker.end).not.toHaveBeenCalled(); expect(state.listener.end).not.toHaveBeenCalled();
    expect(state.retirementLock.end).not.toHaveBeenCalled();
    release(); await vi.advanceTimersByTimeAsync(0);
    for (const pool of [state.worker, state.listener, state.retirementLock]) expect(pool.end).toHaveBeenCalledOnce();
    expect(state.api.end).toHaveBeenCalledTimes(role === "combined" ? 1 : 0);
    expect(instance("CloudWorkspaceSetupWorker").stop).toHaveBeenCalledOnce(); expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
