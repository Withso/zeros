import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  role: "combined", channel: "alpha", cloudEnabled: false, workosEnabled: true, maintenance: false, migrationState: "current",
  apiPool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() },
  workerPool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() },
  listenerPool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() },
  createPool: vi.fn(), serve: vi.fn(), createApp: vi.fn(() => ({ fetch: vi.fn() })),
  startWorkos: vi.fn(), workos: { notify: vi.fn(), stop: vi.fn(async () => {}) },
  notifications: vi.fn(), stopNotifications: vi.fn(async () => {}),
  securityConstructor: vi.fn(), securityStart: vi.fn(), securityNotify: vi.fn(), securityStop: vi.fn(async () => {}),
  brokerConstructor: vi.fn(), broker: { stop: vi.fn(async () => {}) },
  cloud: vi.fn(), lifecycle: { start: vi.fn() }, lifecycleStop: vi.fn(async () => {}),
  loginChanges: { stop: vi.fn(async () => {}) }, relay: { close: vi.fn(), handleUpgrade: vi.fn() },
  routes: {}, proxy: {}, server: { on: vi.fn(), close: vi.fn() },
}));
vi.mock("./config.js", async original => {
  const actual = await original<typeof import("./config.js")>();
  return { ...actual, loadConfig: () => ({ ...actual.loadConfig({
    DATABASE_URL: "postgres://fixture@localhost/test_boot", DATABASE_MIGRATIONS_ON_BOOT: "false",
    AUTH0_DOMAIN: "identity.example.test", AUTH_AUDIENCE: "https://api.example.test",
    CONTROL_PLANE_PROCESS_ROLE: f.role, RAILWAY_ENVIRONMENT_NAME: f.channel,
    CLOUD_V2_WORKER_SIGNING_KEY: generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    CLOUD_V2_ENABLED: String(f.cloudEnabled), BOAT_API_KEY: "synthetic-never-used",
    CLOUD_V2_API_URL: "https://api.example.test", CLOUD_V2_REALTIME_URL: "wss://realtime.example.test",
    CLOUD_V2_RUNTIME_SHA256: "a".repeat(64), CLOUD_V2_RUNTIME_STORE_ENDPOINT: "https://storage.example.test",
    CLOUD_V2_RUNTIME_STORE_BUCKET: "test", CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID: "fixture", CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY: "fixture",
  }), databaseMaintenanceMode: f.maintenance,
  ...(f.workosEnabled ? { auth: { provider: "workos" }, workos: {} } : {}),
  workerPollIntervalsMs: { workos: 2_000, security: 3_000 },
  }) };
});
vi.mock("./db.js", async original => ({ ...(await original<typeof import("./db.js")>()), createPool: f.createPool }));
vi.mock("./migrate.js", async original => ({ ...(await original<typeof import("./migrate.js")>()),
  verifyMigrations: async () => ({ ran: [], status: { state: f.migrationState, migration: "fixture", dependentRuntime: "fixture" } }),
}));
vi.mock("./email.js", () => ({ loadEmailConfig: () => ({ from: null, apiKey: null }), sendEmailStrict: vi.fn() }));
vi.mock("./app.js", () => ({ createApp: f.createApp }));
vi.mock("./workos-provider.js", () => ({ RailwayWorkOSProvider: class {} }));
vi.mock("./workos-sync-runtime.js", () => ({ startWorkOSSyncRuntime: f.startWorkos }));
vi.mock("./security-events.js", () => ({
  PostgresSecurityEventBroker: class { constructor(pool: unknown) { f.brokerConstructor(pool); return f.broker; } },
  SecurityEventPublisher: class {
    constructor(...args: unknown[]) { f.securityConstructor(...args); }
    start = f.securityStart; notify = f.securityNotify;
  },
}));
vi.mock("./worker-notifications.js", () => ({ startWorkerNotifications: f.notifications }));
vi.mock("./cloud/composition.js", () => ({ createCloudV2: f.cloud }));
vi.mock("@hono/node-server", () => ({ serve: f.serve }));

let oldTerm: ReturnType<typeof process.listeners>, oldInt: ReturnType<typeof process.listeners>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  f.role = "combined"; f.channel = "alpha"; f.cloudEnabled = false; f.workosEnabled = true; f.maintenance = false; f.migrationState = "current";
  oldTerm = process.listeners("SIGTERM"); oldInt = process.listeners("SIGINT");
  for (const pool of [f.apiPool, f.workerPool, f.listenerPool]) {
    pool.query.mockImplementation(() => { throw new Error("unexpected database query"); });
    pool.connect.mockImplementation(() => { throw new Error("unexpected database acquisition"); });
  }
  f.createPool.mockImplementation((_url, options) => options.workload === "worker" ? f.workerPool : options.workload === "listener" ? f.listenerPool : f.apiPool);
  f.startWorkos.mockReturnValue(f.workos); f.securityStart.mockReturnValue(f.securityStop);
  f.notifications.mockReturnValue(f.stopNotifications); f.lifecycle.start.mockReturnValue(f.lifecycleStop);
  f.cloud.mockImplementation((config, _pool, roles) => config.cloudV2 ? {
    routes: f.routes, proxy: f.proxy, connections: f.relay, workers: {}, relay: roles.relay ? f.relay : null,
    lifecycle: roles.lifecycle ? f.lifecycle : null, loginChanges: roles.relay ? f.loginChanges : null,
  } : null);
  f.serve.mockImplementation((_options, ready) => { ready({ port: 8080 }); return f.server; });
  f.server.close.mockImplementation(callback => callback());
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const listener of process.listeners("SIGTERM")) if (!oldTerm.includes(listener)) process.removeListener("SIGTERM", listener);
  for (const listener of process.listeners("SIGINT")) if (!oldInt.includes(listener)) process.removeListener("SIGINT", listener);
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe("account workers and cloud v2 boot composition", () => {
  it.each(["api", "realtime"])("runs no account, security publication or VM lifecycle workers in the %s role", async role => {
    f.role = role; f.cloudEnabled = true;
    await import("./index.js"); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.startWorkos).not.toHaveBeenCalled(); expect(f.securityStart).not.toHaveBeenCalled();
    expect(f.notifications).not.toHaveBeenCalled(); expect(f.lifecycle.start).not.toHaveBeenCalled();
    expect(f.createPool.mock.calls.map(call => call[1].workload).sort()).toEqual(["api", "listener"]);
    expect(f.cloud).toHaveBeenCalledExactlyOnceWith(expect.anything(), f.apiPool,
      { relay: role === "realtime", lifecycle: false }, f.broker, f.listenerPool);
    expect(f.createApp.mock.calls[0]![3]).toMatchObject({ securityEventBroker: f.broker });
  });

  it("uses the worker pool and keeps account work enabled without cloud", async () => {
    f.role = "worker";
    await import("./index.js");
    expect(f.createPool.mock.calls.map(call => call[1].workload).sort()).toEqual(["listener", "worker"]);
    expect(f.startWorkos).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pool: f.workerPool }));
    expect(f.securityConstructor).toHaveBeenCalledExactlyOnceWith(f.workerPool, console, { intervalMs: 3_000 });
    expect(f.notifications.mock.calls[0]![0]).toBe(f.listenerPool);
    expect(f.lifecycle.start).not.toHaveBeenCalled();
  });

  it("registers WorkOS/security wakes and retains explicit polling overrides", async () => {
    await import("./index.js");
    expect(f.startWorkos).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pool: f.workerPool, intervalMs: 2_000, deletionLifecycleEnabled: true }));
    const handlers = f.notifications.mock.calls[0]![1] as Record<string, () => void>;
    expect(Object.keys(handlers).sort()).toEqual(["security", "workos"]);
    handlers.workos!(); handlers.security!();
    expect(f.workos.notify).toHaveBeenCalledOnce(); expect(f.securityNotify).toHaveBeenCalledOnce();
    expect(f.brokerConstructor).toHaveBeenCalledExactlyOnceWith(f.listenerPool);
    expect(f.apiPool.query).not.toHaveBeenCalled(); expect(f.apiPool.connect).not.toHaveBeenCalled();
  });

  it.each(["beta", "production"])("preserves shared security while cloud is gated off on %s", async channel => {
    f.channel = channel; f.cloudEnabled = true; f.workosEnabled = false;
    await import("./index.js");
    expect(f.cloud).toHaveBeenCalledWith(expect.objectContaining({ cloudV2: null }), f.workerPool, expect.anything(), f.broker, f.listenerPool);
    expect(f.lifecycle.start).not.toHaveBeenCalled(); expect(f.securityStart).toHaveBeenCalledOnce();
    expect(Object.keys(f.notifications.mock.calls[0]![1])).toEqual(["security"]);
    expect(f.createApp.mock.calls[0]![3]).toMatchObject({ securityEventBroker: f.broker });
  });

  it("pauses deletion and cloud runtime at a controlled migration boundary", async () => {
    f.migrationState = "controlled_migration_pending"; f.cloudEnabled = true;
    await import("./index.js");
    expect(f.startWorkos).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deletionLifecycleEnabled: false }));
    expect(f.securityStart).not.toHaveBeenCalled(); expect(f.notifications).not.toHaveBeenCalled();
    expect(f.cloud).not.toHaveBeenCalled();
  });

  it("starts no background work in maintenance mode", async () => {
    f.maintenance = true; f.cloudEnabled = true;
    await import("./index.js");
    expect(f.startWorkos).not.toHaveBeenCalled(); expect(f.securityStart).not.toHaveBeenCalled();
    expect(f.notifications).not.toHaveBeenCalled(); expect(f.cloud).not.toHaveBeenCalled();
  });

  it("shares the broker with v2 and stops listeners before draining all owned pools", async () => {
    f.cloudEnabled = true;
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await import("./index.js");
    expect(f.cloud).toHaveBeenCalledExactlyOnceWith(expect.anything(), f.workerPool, { relay: true, lifecycle: true }, f.broker, f.listenerPool);
    expect(f.lifecycle.start).toHaveBeenCalledOnce();
    const shutdown = process.listeners("SIGTERM").find(listener => !oldTerm.includes(listener))!;
    shutdown("SIGTERM"); await vi.advanceTimersByTimeAsync(0);
    expect(f.relay.close).toHaveBeenCalledOnce(); expect(f.lifecycleStop).toHaveBeenCalledOnce();
    expect(f.loginChanges.stop).toHaveBeenCalledOnce(); expect(f.broker.stop).toHaveBeenCalledOnce();
    expect(f.stopNotifications).toHaveBeenCalledOnce(); expect(f.workos.stop).toHaveBeenCalledOnce(); expect(f.securityStop).toHaveBeenCalledOnce();
    for (const pool of [f.apiPool, f.workerPool, f.listenerPool]) expect(pool.end).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
