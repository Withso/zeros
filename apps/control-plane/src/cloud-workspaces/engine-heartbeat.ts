/** Checkpoint directives ride the engine heartbeat, so its cadence bounds how
 * long a stop, archive or rebuild waits before the final checkpoint begins.
 * Each beat is also a workspace-locked transaction, so a larger fleet may
 * trade that latency for load. Engines accept 5–60 seconds; at most 30 keeps
 * three beats inside the 90-second lease. */
export const MIN_ENGINE_HEARTBEAT_INTERVAL_MS = 5_000;
export const MAX_ENGINE_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_ENGINE_HEARTBEAT_INTERVAL_MS = 10_000;

/** Registration and heartbeat requests admitted per egress address each
 * minute: room for 300 engines behind one address at the given cadence. */
export function engineLifecycleRequestsPerMinute(intervalMs: number): number {
  return Math.ceil((300 * 60_000) / intervalMs);
}
