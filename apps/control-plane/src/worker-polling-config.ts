import { z } from "zod";

const worker = z.enum(["workos", "outbox", "access", "invitations", "security", "setup", "forks", "checkpoints",
  "lifecycle", "operations", "retirement", "templates", "runtimeStaging"]);
const intervals = z.record(worker, z.number().int().min(100).max(300_000));
export type WorkerPollIntervals = z.infer<typeof intervals>;

/** An explicit interval is a per-worker fallback override. Deadlines and
 * commit hints still wake sooner, and claims retain all their normal fences. */
export function loadWorkerPollIntervals(env: NodeJS.ProcessEnv, cloudEnabled = true): WorkerPollIntervals {
  try {
    const explicit = intervals.parse(JSON.parse(env.WORKER_POLL_INTERVALS_MS ?? "{}"));
    const legacy: WorkerPollIntervals = {};
    // Preserve explicitly configured legacy cadences. Their old implicit
    // 1s/5s defaults no longer override the deadline scheduler's defaults.
    if (cloudEnabled && env.CLOUD_WORKSPACE_RECONCILE_INTERVAL_MS !== undefined) {
      const interval = z.coerce.number().int().min(100).max(300_000).parse(env.CLOUD_WORKSPACE_RECONCILE_INTERVAL_MS);
      for (const name of ["access", "outbox", "forks", "checkpoints", "lifecycle"] as const) legacy[name] = interval;
      legacy.operations = Math.max(5_000, interval);
    }
    if (cloudEnabled && env.CLOUD_WORKSPACE_SETUP_INTERVAL_MS !== undefined) {
      legacy.setup = z.coerce.number().int().min(100).max(300_000).parse(env.CLOUD_WORKSPACE_SETUP_INTERVAL_MS);
    }
    const result = { ...legacy, ...explicit };
    if ((result.operations !== undefined && result.operations < 1_000) ||
        (result.forks !== undefined && result.forks < 250) ||
        (result.checkpoints !== undefined && result.checkpoints < 500) ||
        (result.access !== undefined && result.access > 60_000) ||
        (result.setup !== undefined && result.setup > 60_000)) throw new Error();
    return result;
  } catch { throw new Error("Invalid worker polling intervals"); }
}

export function workerPollingOptions(intervals: WorkerPollIntervals | undefined, name: keyof WorkerPollIntervals): { intervalMs?: number } {
  const intervalMs = intervals?.[name];
  return intervalMs === undefined ? {} : { intervalMs };
}
