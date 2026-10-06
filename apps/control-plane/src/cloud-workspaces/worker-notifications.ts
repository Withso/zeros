import type pg from "pg";
import { DATABASE_CONNECTION_LIFETIME_SECONDS } from "../db.js";

/** One dedicated, disposable LISTEN session. SQL notifications contain no
 * identity or authority: workers always re-read and claim through their normal
 * fenced transactions. Polling remains active when this fast path is down. */
export function startCloudWorkerNotifications(
  pool: pg.Pool,
  workers: { lifecycle: () => void; setup: () => void },
  logger: Pick<Console, "warn"> = console,
): () => Promise<void> {
  let stopped = false;
  let connecting: Promise<void> | undefined;
  let disconnect: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let retryMs = 1_000;

  const reconnect = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = undefined; connect(); }, retryMs);
    timer.unref();
    retryMs = Math.min(30_000, retryMs * 2);
  };
  const connect = () => {
    if (stopped || connecting || disconnect) return;
    connecting = (async () => {
      const client = await pool.connect();
      if (stopped) { client.release(true); return; }
      let disposed = false;
      let retirement: NodeJS.Timeout | undefined;
      const notify = (notice: pg.Notification) => {
        if (stopped || disposed || notice.payload !== "") return;
        if (notice.channel === "zeros_cloud_lifecycle_work") workers.lifecycle();
        if (notice.channel === "zeros_cloud_setup_work") workers.setup();
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(retirement);
        client.removeListener("notification", notify);
        disconnect = undefined;
        // Keep the idempotent error handler through socket teardown. A checked
        // out LISTEN client must never return to a pool with session state.
        client.release(true);
        reconnect();
      };
      client.on("notification", notify);
      client.on("error", dispose);
      client.on("end", dispose);
      disconnect = dispose;
      try {
        await client.query("LISTEN zeros_cloud_lifecycle_work; LISTEN zeros_cloud_setup_work");
        if (disposed || stopped) { dispose(); return; }
        retryMs = 1_000;
        retirement = setTimeout(dispose, DATABASE_CONNECTION_LIFETIME_SECONDS * 1_000);
        retirement.unref();
        // Commit(s) before LISTEN became active may have been missed.
        workers.lifecycle();
        workers.setup();
      } catch {
        dispose();
        throw new Error("worker_listener_unavailable");
      }
    })().catch(() => {
      logger.warn("[cloud-workspace] worker notifications unavailable; polling remains enabled");
    }).finally(() => {
      connecting = undefined;
      if (!disconnect) reconnect();
    });
  };
  connect();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    disconnect?.();
    await connecting;
  };
}
