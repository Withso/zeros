import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { loadWorkerPollIntervals } from "./worker-polling-config.js";
import { workosTestEnv } from "./test-workos-env.js";

const env = { DATABASE_URL: "postgres://fixture@localhost/worker-config-test", ...workosTestEnv(), AUTH_AUDIENCE: "test" };
describe("per-worker polling rollback", () => {
  it("defaults to scheduler deadlines and allows only the selected worker's interval to change", () => {
    expect(loadConfig(env).workerPollIntervalsMs).toEqual({});
    expect(loadConfig({ ...env, WORKER_POLL_INTERVALS_MS: '{"workos":5000,"security":1000}' })
      .workerPollIntervalsMs).toEqual({ workos: 5_000, security: 1_000 });
  });
  it.each(['{"workos":0}', '{"workos":300001}', '{"other":1000}', '{"workos":1.5}', 'secret-sentinel',
    '{"setup":60001}', '{"access":60001}', '{"forks":249}', '{"checkpoints":499}', '{"operations":999}'])(
    "rejects invalid overrides without reflecting the value", value => {
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
      ),
    ).toEqual({ workos: 2000 });
  });
});
