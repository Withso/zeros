import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  migrationState: "current",
  pool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() },
  serve: vi.fn(),
  workos: { notify: vi.fn(), stop: vi.fn(async () => {}) },
  startWorkos: vi.fn(),
  notifications: vi.fn(() => async () => {}),
  security: vi.fn(() => async () => {}),
  securityNotify: vi.fn(),
  boat: vi.fn(),
}));

vi.mock("./config.js", async original => {
  const actual = await original<typeof import("./config.js")>();
  return { ...actual, loadConfig: () => ({
    ...actual.loadConfig({
      DATABASE_URL: "postgres://fixture@localhost/test_account_workers",
      DATABASE_MIGRATIONS_ON_BOOT: "false",
      AUTH0_DOMAIN: "identity.example.test", AUTH_AUDIENCE: "https://api.example.test",
      CLOUD_WORKSPACES_ENABLED: "false",
    }),
    auth: { provider: "workos" }, workos: {}, workerPollIntervalsMs: { workos: 2_000 },
  }) };
});
vi.mock("./db.js", async original => ({
  ...(await original<typeof import("./db.js")>()), createPool: () => fixture.pool,
}));
vi.mock("./migrate.js", async original => ({
  ...(await original<typeof import("./migrate.js")>()),
  verifyMigrations: async () => ({ ran: [], status: {
    state: fixture.migrationState, migration: "fixture", dependentRuntime: "fixture",
  } }),
}));
vi.mock("./email.js", () => ({ loadEmailConfig: () => ({ from: null, apiKey: null }), sendEmailStrict: vi.fn() }));
vi.mock("./app.js", () => ({ createApp: () => ({ fetch: vi.fn() }) }));
vi.mock("./workos-provider.js", () => ({ RailwayWorkOSProvider: class {} }));
vi.mock("./workos-sync-runtime.js", () => ({ startWorkOSSyncRuntime: fixture.startWorkos }));
vi.mock("./security-events.js", () => ({
  PostgresSecurityEventBroker: class { stop() {} },
  SecurityEventPublisher: class { start = fixture.security; notify = fixture.securityNotify; },
}));
vi.mock("./cloud-workspaces/worker-notifications.js", () => ({ startCloudWorkerNotifications: fixture.notifications }));
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
  fixture.pool.query.mockImplementation(() => { throw new Error("unexpected database query"); });
  fixture.pool.connect.mockImplementation(() => { throw new Error("unexpected database acquisition"); });
  fixture.startWorkos.mockReturnValue(fixture.workos);
  fixture.serve.mockImplementation((_options, ready) => { ready({ port: 8080 }); return { on: vi.fn() }; });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const listener of process.listeners("SIGTERM")) if (!oldTerm.includes(listener)) process.removeListener("SIGTERM", listener);
  for (const listener of process.listeners("SIGINT")) if (!oldInt.includes(listener)) process.removeListener("SIGINT", listener);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("account maintenance without cloud workspaces", () => {
  it("registers account and security wakes and preserves the account override", async () => {
    fixture.migrationState = "current";
    await import("./index.js");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fixture.startWorkos).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      intervalMs: 2_000, deletionLifecycleEnabled: true,
    }));
    expect(fixture.notifications).toHaveBeenCalledOnce();
    const handlers = fixture.notifications.mock.calls[0]![1] as Record<string, () => void>;
    expect(Object.keys(handlers).sort()).toEqual(["security", "workos"]);
    handlers.workos!(); handlers.security!();
    expect(fixture.workos.notify).toHaveBeenCalledOnce();
    expect(fixture.securityNotify).toHaveBeenCalledOnce();
    expect(fixture.boat).not.toHaveBeenCalled();
    expect(fixture.pool.query).not.toHaveBeenCalled();
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });

  it("keeps deletion disabled at its existing controlled migration boundary", async () => {
    fixture.migrationState = "controlled_migration_pending";
    await import("./index.js");
    expect(fixture.startWorkos).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      intervalMs: 2_000, deletionLifecycleEnabled: false,
    }));
    expect(fixture.notifications).not.toHaveBeenCalled();
    expect(fixture.boat).not.toHaveBeenCalled();
    expect(fixture.pool.query).not.toHaveBeenCalled();
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });
});
