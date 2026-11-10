import { CloudWorkerScheduler } from "../../worker-scheduler.js";
import type { CloudLocalCommands } from "./requests.js";
import type { CloudLocalCommandSignals } from "./signals.js";

export function startLocalCommandMaintenance(requests: CloudLocalCommands, signals: CloudLocalCommandSignals,
  logger: Pick<Console,"error"> = console): () => Promise<void> {
  const scheduler = new CloudWorkerScheduler(60_000, async () => {
    for (let batch = 0; batch < 4; batch++) if (await requests.sweep() < 128) break;
  }, () => logger.error("[local-commands] maintenance_unavailable"), () => requests.nextDue(), { readBeforeRun: true, jitter: true });
  const unsubscribe = signals.subscribe(() => scheduler.notify());
  void signals.start().catch(() => logger.error("[local-commands] notifications_unavailable"));
  scheduler.start();
  return async () => { unsubscribe(); await scheduler.stop(); };
}
