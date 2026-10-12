import type pg from "pg";

import {
  EmailDeliveryError,
  sendEmailStrict,
  type EmailConfig,
} from "./email.js";
import {
  SecurityNotificationDeliveryError,
  SecurityNotificationProcessor,
} from "./security-notification-outbox.js";
import { WorkOSCommandProcessor } from "./workos-command-outbox.js";
import type { WorkOSManagementProvider } from "./workos-provider.js";
import { WorkOSEventsReconciler } from "./workos-sync-events.js";
import { DeletionLifecycleProcessor } from "./deletion-lifecycle.js";

import { CloudWorkerScheduler } from "./cloud-workspaces/worker-scheduler.js";
import {
  readWorkOSWorkerDeadlines,
  type WorkOSWork,
} from "./workos-worker-deadlines.js";

type SyncLogger = Pick<Console, "info" | "warn" | "error">;

export type WorkOSSyncRuntimeOptions = {
  pool: pg.Pool;
  provider: WorkOSManagementProvider;
  email: EmailConfig;
  /** Product-originated changes should reach WorkOS promptly. */
  commandIntervalMs?: number;
  /** Explicit fallback override for the shared account queue deadline read. */
  intervalMs?: number;
  /** Webhooks are immediate; Events API is the ordered repair path. */
  eventIntervalMs?: number;
  notificationIntervalMs?: number;
  deletionIntervalMs?: number;
  /**
   * Keep false while the schema needed by the deletion lifecycle is behind a
   * controlled migration boundary. The other WorkOS repair loops remain safe
   * and continue running in that state.
   */
  deletionLifecycleEnabled?: boolean;
  logger?: SyncLogger;
};

/** One idle read covers the account queues. Each processor retains its own
 * flight and batch cadence; a slow provider call cannot block other queues.
 * Events API repair remains independent of the transactional wake path. */
export function startWorkOSSyncRuntime(options: WorkOSSyncRuntimeOptions): {
  notify(): void;
  stop(): Promise<void>;
} {
  const logger = options.logger ?? console;
  const commands = new WorkOSCommandProcessor(options.pool, options.provider, {
    logger,
  });
  const events = new WorkOSEventsReconciler(options.pool, options.provider);
  const notifications = new SecurityNotificationProcessor(
    options.pool,
    async (delivery) => {
      try {
        const receipt = await sendEmailStrict(
          options.email,
          delivery.destinationEmail,
          delivery.subject,
          delivery.html,
          { idempotencyKey: delivery.idempotencyKey },
        );
        return { providerMessageId: receipt.messageId };
      } catch (error) {
        if (error instanceof EmailDeliveryError)
          throw new SecurityNotificationDeliveryError(
            error.code,
            error.retryable,
          );
        throw error;
      }
    },
    { logger },
  );
  const deletions =
    options.deletionLifecycleEnabled === false
      ? null
      : new DeletionLifecycleProcessor(options.pool, { logger });
  const work: Record<WorkOSWork, () => Promise<number>> = {
    commands: () => commands.tick(50),
    notifications: () => notifications.tick(4),
    deletions: () => deletions?.tick(10) ?? Promise.resolve(0),
  };
  // Preserve the existing rate limits between nonempty batches, including
  // Resend's deliberately small team-wide security-mail burst.
  const cadence: Record<WorkOSWork, number> = {
    commands: options.commandIntervalMs ?? 2_000,
    notifications: options.notificationIntervalMs ?? 5_000,
    deletions: options.deletionIntervalMs ?? 15_000,
  };
  const overrides = [
    options.commandIntervalMs,
    options.notificationIntervalMs,
    options.deletionIntervalMs,
  ].filter((value): value is number => value !== undefined);
  const interval = options.intervalMs ?? Math.min(60_000, ...overrides);
  const active = new Map<WorkOSWork, Promise<void>>(),
    nextAllowed = new Map<WorkOSWork, number>();
  let stopped = false,
    due = new Set<WorkOSWork>();
  const scheduler = new CloudWorkerScheduler(
    interval,
    async () => {
      for (const kind of due) {
        if (stopped || active.has(kind)) continue;
        const task = Promise.resolve()
          .then(work[kind])
          .then((count) => {
            if (count > 0) logger.info(`[workos-sync] ${kind}: ${count}`);
          })
          .catch(() => logger.error(`[workos-sync] ${kind} tick failed`))
          .finally(() => {
            active.delete(kind);
            nextAllowed.set(kind, Date.now() + cadence[kind]);
            if (!stopped) scheduler.notify();
          });
        active.set(kind, task);
      }
    },
    () =>
      logger.error(
        "[workos-sync] deadline read failed; fallback remains enabled",
      ),
    async () => {
      const deadlines = await readWorkOSWorkerDeadlines(
        options.pool,
        deletions !== null,
      );
      due = new Set();
      const delays: number[] = [];
      for (const [kind, delay] of Object.entries(deadlines) as [
        WorkOSWork,
        number,
      ][]) {
        if (active.has(kind)) continue;
        const next = Math.max(delay, (nextAllowed.get(kind) ?? 0) - Date.now());
        if (next <= 0) due.add(kind);
        delays.push(next);
      }
      return delays.length ? Math.min(...delays) : null;
    },
    {
      readBeforeRun: true,
      jitter: options.intervalMs === undefined && overrides.length === 0,
    },
  );
  const eventScheduler = new CloudWorkerScheduler(
    options.eventIntervalMs ?? 60_000,
    async () => {
      const count = await events.tick();
      if (count > 0) logger.info(`[workos-sync] events: ${count}`);
    },
    () => logger.error("[workos-sync] events tick failed"),
  );
  scheduler.start();
  eventScheduler.start();
  return {
    notify: () => scheduler.notify(),
    async stop() {
      if (stopped) return;
      stopped = true;
      await Promise.all([scheduler.stop(), eventScheduler.stop()]);
      await Promise.all(active.values());
    },
  };
}
