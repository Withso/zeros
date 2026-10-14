import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  channel: "beta",
  pool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() },
  listenerPool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() },
  createPool: vi.fn(),
  securityBroker: vi.fn(),
  serve: vi.fn(),
  app: vi.fn(() => ({ fetch: vi.fn() })),
  securityStart: vi.fn(),
  cloudNotifications: vi.fn(),
  checkpointNotifications: vi.fn(),
  boat: vi.fn(),
}));
vi.mock("./config.js", async original => {
  const actual = await original<typeof import("./config.js")>();
  return { ...actual, loadConfig: () => actual.loadConfig({
    DATABASE_URL: "postgres://synthetic@localhost/test_channel_pause", DATABASE_MIGRATIONS_ON_BOOT: "false",
    AUTH0_DOMAIN: "identity.example.test", AUTH_AUDIENCE: "https://api.example.test", RAILWAY_ENVIRONMENT_NAME: fixture.channel,
    CLOUD_WORKSPACES_ENABLED: "true", CLOUD_RUNTIME_PUBLICATION_ENABLED: "true",
    CLOUD_RUNTIME_QUALIFICATION_ENABLED: "true", CLOUD_RUNTIME_IMAGES_ENABLED: "true", CLOUD_RUNTIME_STAGING_ENABLED: "true",
    CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "true", CLOUD_WORKSPACE_BACKGROUND_WORKERS_ENABLED: "true",
    CLOUD_WORKSPACE_PROVIDER: "stale-provider", CLOUD_WORKSPACE_NEW_RUNTIME_PROFILE: "legacy",
  }) };
});
vi.mock("./db.js", async original => ({
  ...(await original<typeof import("./db.js")>()), createPool: fixture.createPool,
}));
vi.mock("./migrate.js", async original => ({
  ...(await original<typeof import("./migrate.js")>()),
  verifyMigrations: async () => ({ ran: [], status: { state: "current" } }),
}));
vi.mock("./email.js", () => ({ loadEmailConfig: () => ({ from: null, apiKey: null }), sendEmailStrict: vi.fn() }));
vi.mock("./app.js", () => ({ createApp: fixture.app }));
vi.mock("./security-events.js", () => ({
  PostgresSecurityEventBroker: class { constructor(pool: unknown) { fixture.securityBroker(pool); } stop() {} },
  SecurityEventPublisher: class {
    start() { fixture.securityStart(); return async () => {}; }
    notify() {}
  },
}));
vi.mock("./cloud-workspaces/worker-notifications.js", () => ({ startCloudWorkerNotifications: fixture.cloudNotifications }));
vi.mock("./cloud-workspaces/engine-checkpoint-hints.js", async original => ({
  ...(await original<typeof import("./cloud-workspaces/engine-checkpoint-hints.js")>()),
  startCloudEngineCheckpointHintNotifications: fixture.checkpointNotifications,
}));
vi.mock("./cloud-workspaces/boat-client.js", async original => ({
  ...(await original<typeof import("./cloud-workspaces/boat-client.js")>()), BoatApiClient: fixture.boat,
}));
vi.mock("@hono/node-server", () => ({ serve: fixture.serve }));

let oldTerm: ReturnType<typeof process.listeners>, oldInt: ReturnType<typeof process.listeners>;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  oldTerm = process.listeners("SIGTERM"); oldInt = process.listeners("SIGINT");
  fixture.pool.query.mockImplementation(() => { throw new Error("unexpected cloud polling"); });
  fixture.pool.connect.mockImplementation(() => { throw new Error("unexpected cloud listener"); });
  fixture.createPool.mockImplementation((_url, options) => options.applicationName ? fixture.listenerPool : fixture.pool);
  fixture.serve.mockImplementation((_options, ready) => { ready({ port: 8080 }); return { on: vi.fn() }; });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const listener of process.listeners("SIGTERM")) if (!oldTerm.includes(listener)) process.removeListener("SIGTERM", listener);
  for (const listener of process.listeners("SIGINT")) if (!oldInt.includes(listener)) process.removeListener("SIGINT", listener);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("paused-channel control-plane startup", () => {
  it.each(["beta", "production"])("starts no cloud workers, listeners or provider clients on %s", async channel => {
    fixture.channel = channel;
    await import("./index.js");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fixture.serve).toHaveBeenCalledOnce();
    expect(fixture.securityStart).toHaveBeenCalledOnce(); // Shared security remains on.
    // The one shared listener serves security/directory publication only; no
    // cloud worker handler is registered while the channel is paused.
    expect(fixture.cloudNotifications).toHaveBeenCalledOnce();
    expect(Object.keys(fixture.cloudNotifications.mock.calls[0]![1] as object)).toEqual(["security"]);
    expect(fixture.checkpointNotifications).not.toHaveBeenCalled();
    expect(fixture.boat).not.toHaveBeenCalled();
    expect(fixture.pool.query).not.toHaveBeenCalled();
    expect(fixture.pool.connect).not.toHaveBeenCalled();
    expect(fixture.createPool).toHaveBeenCalledTimes(2);
    expect(fixture.createPool).toHaveBeenLastCalledWith(expect.any(String), {
      maxConnections: 2, applicationName: "zeros-notifications",
    });
    expect(fixture.securityBroker).toHaveBeenCalledExactlyOnceWith(fixture.listenerPool);
    expect(fixture.cloudNotifications.mock.calls[0]![0]).toBe(fixture.listenerPool);
    expect(fixture.app).toHaveBeenCalledWith(expect.objectContaining({ cloudWorkspaces: null,
      cloudAgentCredentials: null, selectedCloudWorker: null, cloudRuntimePublication: expect.objectContaining({ enabled: false, s3: null }) }),
    fixture.pool, expect.anything(), expect.objectContaining({ runtimePublication: expect.objectContaining({ artifacts: null }) }));
  });
});
