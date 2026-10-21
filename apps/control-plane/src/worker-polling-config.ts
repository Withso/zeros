import { z } from "zod";

const worker = z.enum(["workos", "security"]);
const intervals = z.record(worker, z.number().int().min(100).max(300_000));
export type WorkerPollIntervals = z.infer<typeof intervals>;

/** An explicit interval is a per-worker fallback override. Deadlines and
 * commit hints still wake sooner, and claims retain all their normal fences. */
export function loadWorkerPollIntervals(env: NodeJS.ProcessEnv): WorkerPollIntervals {
  try {
    const explicit = intervals.parse(JSON.parse(env.WORKER_POLL_INTERVALS_MS ?? "{}"));
    return explicit;
  } catch { throw new Error("Invalid worker polling intervals"); }
}

export function workerPollingOptions(intervals: WorkerPollIntervals | undefined, name: keyof WorkerPollIntervals): { intervalMs?: number } {
  const intervalMs = intervals?.[name];
  return intervalMs === undefined ? {} : { intervalMs };
}
