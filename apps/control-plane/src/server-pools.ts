// The server process's database pools. Every pool that runs organization
// queries carries the process's transaction settings, so the API, the cloud
// stores (on the worker pool in the combined and worker roles), the queue and
// the project builder agree on whether a Personal organization has cloud.
import type pg from "pg";
import type { Config } from "./config.js";
import { configureCloudPersonal } from "./db-context.js";
import { createPool } from "./db.js";

export type ServerPools = {
  /** Requests and WebSocket upgrades; the worker pool in a worker-only process. */
  pool: pg.Pool;
  workerPool: pg.Pool | null;
  /** The pool createCloudV2 runs on. */
  cloud: pg.Pool;
  /** LISTEN only: it runs no organization queries, so it carries no settings. */
  listenerPool: pg.Pool;
  /** Cloud Computer build locks; their transactions read organizations. */
  advisoryLockPool(): pg.Pool;
};

export function createServerPools(config: Config, processRole: NonNullable<Config["processRole"]>): ServerPools {
  const configured = (pool: pg.Pool) => {
    configureCloudPersonal(pool, config.cloudV2?.personalCloud === true);
    return pool;
  };
  const servesApi = processRole !== "worker";
  const workerPool = processRole === "worker" || processRole === "combined"
    ? configured(createPool(config.databaseUrl, { workload: "worker", applicationName: "zeros-workers" })) : null;
  // A worker-only process uses its worker pool for readiness. It never creates
  // an unused API pool, and API replicas never start durable queue consumers.
  const pool = servesApi ? configured(createPool(config.databaseUrl, {
    workload: "api", maxConnections: config.databasePoolMax ?? 6,
    ...(processRole === "realtime" ? { applicationName: "zeros-realtime" } : {}),
  })) : workerPool!;
  // LISTEN is session-scoped and must bypass transaction poolers. All consumers
  // share one disposable session, in an isolated pool using runtime privileges.
  const listenerPool = createPool(config.databaseListenUrl ?? config.databaseUrl, {
    workload: "listener", maxConnections: 2, applicationName: "zeros-notifications", keepAlive: true,
  });
  return {
    pool, workerPool, cloud: workerPool ?? pool, listenerPool,
    advisoryLockPool: () => configured(createPool(config.databaseUrl, { workload: "advisory-lock", applicationName: "zeros-computer-locks" })),
  };
}
