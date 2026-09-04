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

type SyncLogger = Pick<Console, "info" | "warn" | "error">;

export type WorkOSSyncRuntimeOptions = {
  pool: pg.Pool;
  provider: WorkOSManagementProvider;
  email: EmailConfig;
  /** Product-originated changes should reach WorkOS promptly. */
  commandIntervalMs?: number;
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

type Loop = {
  timer: NodeJS.Timeout | null;
  active: Promise<void> | null;
};

/**
 * Starts three bounded, non-overlapping loops:
 * - the transactional outbox sends Zeros mutations to WorkOS;
 * - the ordered Events API repairs missed, duplicated, or reordered webhooks.
 * - the security-notification outbox sends account lifecycle mail at least once.
 *
 * Authentication requests never call WorkOS synchronously. Authorization is
 * enforced from the local projection and revision checks, while webhooks/SSE
 * provide the low-latency revocation path.
 */
export function startWorkOSSyncRuntime(options: WorkOSSyncRuntimeOptions): {
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
        if (error instanceof EmailDeliveryError) {
          throw new SecurityNotificationDeliveryError(
            error.code,
            error.retryable,
          );
        }
        throw error;
      }
    },
    { logger },
  );
  const deletions =
    options.deletionLifecycleEnabled === false
      ? null
      : new DeletionLifecycleProcessor(options.pool, { logger });
  const commandLoop: Loop = { timer: null, active: null };
  const eventLoop: Loop = { timer: null, active: null };
  const notificationLoop: Loop = { timer: null, active: null };
  const deletionLoop: Loop = { timer: null, active: null };
  let stopped = false;

  const schedule = (
    loop: Loop,
    intervalMs: number,
    label: string,
    work: () => Promise<number>,
  ): void => {
    const run = () => {
      if (stopped) return;
      const task = work()
        .then((count) => {
          if (count > 0) logger.info(`[workos-sync] ${label}: ${count}`);
        })
        .catch((error) => {
          logger.error(
            `[workos-sync] ${label} tick failed: ${
              error instanceof Error ? error.name : "unknown"
            }`,
          );
        });
      loop.active = task;
      void task.finally(() => {
        if (loop.active === task) loop.active = null;
        if (stopped) return;
        loop.timer = setTimeout(run, intervalMs);
        loop.timer.unref();
      });
    };
    run();
  };

  schedule(commandLoop, options.commandIntervalMs ?? 2_000, "commands", () =>
    commands.tick(50),
  );
  schedule(eventLoop, options.eventIntervalMs ?? 60_000, "events", () =>
    events.tick(),
  );
  schedule(
    notificationLoop,
    options.notificationIntervalMs ?? 5_000,
    "security notifications",
    // Resend rate-limits at the team boundary across every API key. Keep this
    // worker's burst deliberately small; durable retries absorb shared-team
    // contention without delaying authentication requests.
    () => notifications.tick(4),
  );
  if (deletions) {
    schedule(
      deletionLoop,
      options.deletionIntervalMs ?? 15_000,
      "deletion lifecycle",
      () => deletions.tick(10),
    );
  }

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (commandLoop.timer) clearTimeout(commandLoop.timer);
      if (eventLoop.timer) clearTimeout(eventLoop.timer);
      if (notificationLoop.timer) clearTimeout(notificationLoop.timer);
      if (deletionLoop.timer) clearTimeout(deletionLoop.timer);
      commandLoop.timer = null;
      eventLoop.timer = null;
      notificationLoop.timer = null;
      deletionLoop.timer = null;
      await Promise.all([
        commandLoop.active,
        eventLoop.active,
        notificationLoop.active,
        deletionLoop.active,
      ]);
    },
  };
}
