import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionFixture } from "./execution/test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("push-signal producer through the configured worker routes", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(() => pool.end());

  it("offers timer negotiation from real composition only to an opted-in boot", async () => {
    const f = await executionFixture(pool, { teamOwnership: true });
    try {
      await f.login(); await f.activate();
      expect((await f.hello()).status).toBe(200);
      const headers = { authorization: `Bearer ${f.token}`, "x-zeros-worker-boot": f.boot,
        "x-zeros-worker-features": `${f.features},creator-agent-logins-v1` };
      const old = await f.app.request("/v2/cloud/worker/config", { headers });
      expect(old.status).toBe(200);
      expect((await old.json()).config).not.toHaveProperty("pushSignals");
      const current = await f.app.request("/v2/cloud/worker/config", {
        headers: { ...headers, "x-zeros-worker-features": `${headers["x-zeros-worker-features"]},push-signals-v1` },
      });
      expect(current.status).toBe(200);
      expect((await current.json()).config).toMatchObject({ promptOutbox: 1, pushSignals: 1 });
    } finally { await f.close(); }
  });
});
