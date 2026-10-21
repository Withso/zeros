import type pg from "pg";
import { postgresNotificationSubscription } from "./postgres-notifications.js";

const channels = {
  workos: "zeros_account_maintenance_work",
  security: "zeros_security_publication_work",
} as const;
export type WorkerNotificationHandlers = Partial<Record<keyof typeof channels, () => void>>;

/** Hints share the process's dedicated LISTEN session. Notifications contain
 * no identity or authority: workers re-read and claim through their normal
 * fenced transactions, including after every listener reconnect. */
export function startWorkerNotifications(
  pool: pg.Pool, workers: WorkerNotificationHandlers, logger: Pick<Console, "warn"> = console,
): () => Promise<void> {
  const subscriptions = Object.entries(channels).flatMap(([key, channel]) => {
    const wake = workers[key as keyof typeof channels];
    return wake ? [{ channel, wake }] : [];
  });
  if (!subscriptions.length) return async () => {};
  const listener = postgresNotificationSubscription(pool, {
    channels: subscriptions.map(entry => entry.channel),
    onNotification: notice => {
      if (notice.payload === "") subscriptions.find(entry => entry.channel === notice.channel)?.wake();
    },
    onReady: () => { for (const entry of subscriptions) entry.wake(); },
    onUnavailable: () => logger.warn("[control-plane] worker notifications unavailable; polling remains enabled"),
  });
  void listener.start().catch(() => {});
  return () => listener.stop();
}
