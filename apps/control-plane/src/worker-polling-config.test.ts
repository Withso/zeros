import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { loadWorkerPollIntervals } from "./worker-polling-config.js";

const env = { DATABASE_URL: "postgres://fixture@localhost/worker-config-test", AUTH0_DOMAIN: "test.auth0.com", AUTH_AUDIENCE: "test" };
describe("per-worker polling rollback", () => {
  it("defaults to scheduler deadlines and allows only the selected worker's interval to change", () => {
    expect(loadConfig(env).workerPollIntervalsMs).toEqual({});
    expect(loadConfig({ ...env, WORKER_POLL_INTERVALS_MS: '{"outbox":5000,"setup":1000,"security":1000}' })
      .workerPollIntervalsMs).toEqual({ outbox: 5_000, setup: 1_000, security: 1_000 });
  });
  it("preserves explicit legacy settings and lets per-worker overrides take precedence", () => {
    expect(loadWorkerPollIntervals({ CLOUD_WORKSPACE_RECONCILE_INTERVAL_MS: "7000", CLOUD_WORKSPACE_SETUP_INTERVAL_MS: "2000",
      WORKER_POLL_INTERVALS_MS: '{"outbox":1000}' }))
      .toEqual({ access: 7_000, outbox: 1_000, forks: 7_000, checkpoints: 7_000, lifecycle: 7_000, operations: 7_000, setup: 2_000 });
  });
  it("ignores legacy cloud timing settings when cloud is disabled and keeps security overrides available", () => {
    expect(loadConfig({ ...env, CLOUD_WORKSPACES_ENABLED: "false", CLOUD_WORKSPACE_RECONCILE_INTERVAL_MS: "unused-invalid",
      CLOUD_WORKSPACE_SETUP_INTERVAL_MS: "unused-invalid", WORKER_POLL_INTERVALS_MS: '{"security":1000}' }).workerPollIntervalsMs)
      .toEqual({ security: 1_000 });
  });
  it.each(['{"outbox":0}', '{"outbox":300001}', '{"other":1000}', '{"outbox":1.5}', 'secret-sentinel',
    '{"setup":60001}', '{"access":60001}', '{"forks":249}', '{"checkpoints":499}', '{"operations":999}'])
    ("rejects invalid overrides without reflecting the value", value => {
      expect(() => loadConfig({ ...env, WORKER_POLL_INTERVALS_MS: value })).toThrow("Invalid worker polling intervals");
      try { loadConfig({ ...env, WORKER_POLL_INTERVALS_MS: value }); } catch (error) {
        expect(String(error)).not.toContain(value);
      }
    });
});

describe("account queue polling override", () => {
  it("allows the account fallback override with cloud disabled", () => {
    expect(
      loadWorkerPollIntervals(
        { WORKER_POLL_INTERVALS_MS: '{"workos":2000}' },
        false,
      ),
    ).toEqual({ workos: 2000 });
  });
});
