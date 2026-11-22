// The Personal cloud switch reaches every pool the server process runs
// organization queries on, not only the API pool createApp receives.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { configureCloudPersonal } from "./db-context.js";
import { createPool, withSystemTx, withUserTx } from "./db.js";
import { createServerPools } from "./server-pools.js";

const url = process.env.TEST_DATABASE_URL;
const database = url ? describe : describe.skip;
const SWITCH = "SELECT pg_backend_pid() AS pid, current_setting('app.cloud_personal', true) AS personal";

database("server pools and the Personal cloud switch", () => {
  const pools = (personalCloud: boolean) =>
    createServerPools({ databaseUrl: url!, cloudV2: { personalCloud } } as Config, "combined");

  it.each([[true, "1"], [false, "0"]])("with the switch %s, the cloud pool and the API pool both read %s", async (on, expected) => {
    const server = pools(on);
    const lock = server.advisoryLockPool();
    try {
      // The combined role: cloud runs on its own worker pool, not the API pool.
      expect(server.cloud).toBe(server.workerPool);
      expect(server.cloud).not.toBe(server.pool);
      expect((await withSystemTx(server.cloud, tx => tx.query(SWITCH))).rows[0].personal).toBe(expected);
      expect((await withUserTx(server.pool, randomUUID(), tx => tx.query(SWITCH))).rows[0].personal).toBe(expected);
      expect((await withSystemTx(lock, tx => tx.query(SWITCH))).rows[0].personal).toBe(expected);
    } finally {
      await Promise.all([server.pool.end(), server.workerPool!.end(), server.listenerPool.end(), lock.end()]);
    }
  });

  it("a worker-only process runs cloud on its worker pool, with the switch", async () => {
    const server = createServerPools({ databaseUrl: url!, cloudV2: { personalCloud: true } } as Config, "worker");
    try {
      expect(server.pool).toBe(server.workerPool);
      expect((await withSystemTx(server.cloud, tx => tx.query(SWITCH))).rows[0].personal).toBe("1");
    } finally { await Promise.all([server.workerPool!.end(), server.listenerPool.end()]); }
  });

  it("an unconfigured pool reads 0 on a backend whose previous transaction had 1", async () => {
    const one = createPool(url!, { workload: "worker", maxConnections: 1 });
    try {
      configureCloudPersonal(one, true);
      const on = (await withSystemTx(one, tx => tx.query(SWITCH))).rows[0];
      configureCloudPersonal(one, false);
      const off = (await withUserTx(one, randomUUID(), tx => tx.query(SWITCH))).rows[0];
      expect(on.personal).toBe("1");
      expect(off).toEqual({ pid: on.pid, personal: "0" });
    } finally { await one.end(); }
  });
});
