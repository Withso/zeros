import type pg from "pg";
import { postgresNotificationSubscription } from "../postgres-notifications.js";

const channels = {
  workos: "zeros_account_maintenance_work",
  lifecycle: "zeros_cloud_lifecycle_work",
  setup: "zeros_cloud_setup_work",
  runtimeStaging: "zeros_cloud_runtime_staging_work",
  outbox: "zeros_cloud_outbox_work",
  access: "zeros_cloud_access_work",
  invitations: "zeros_cloud_invitation_work",
  security: "zeros_security_publication_work",
  recovery: "zeros_cloud_recovery_work",
  forks: "zeros_cloud_fork_work",
  checkpoints: "zeros_cloud_checkpoint_work",
  operations: "zeros_cloud_operations_work",
  retirement: "zeros_cloud_retirement_work",
  templates: "zeros_cloud_template_work",
} as const;
export type CloudWorkerNotificationHandlers = Partial<Record<keyof typeof channels, () => void>>;

/** Hints share the process's dedicated LISTEN session. Notifications contain
 * no identity or authority: workers re-read and claim through their normal
 * fenced transactions, including after every listener reconnect. */
export function startCloudWorkerNotifications(
  pool: pg.Pool,
  workers: CloudWorkerNotificationHandlers,
  logger: Pick<Console, "warn"> = console,
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
    onUnavailable: () => logger.warn("[cloud-workspace] worker notifications unavailable; polling remains enabled"),
  });
  void listener.start().catch(() => {});
  return () => listener.stop();
}
