import type { CloudV2WorkerTiming } from "@zeros/protocol/cloud-v2-relay";

export type StartupTimingObserver = (record: CloudV2WorkerTiming) => void;

export function recordStartupTiming(phase: CloudV2WorkerTiming["phase"], started: number, observer?: StartupTimingObserver): void {
  const durationMs = Math.min(3_600_000, Math.max(0, Math.round(performance.now() - started)));
  try { observer?.({ phase, durationMs }); } catch { /* Diagnostics never gate worker readiness. */ }
}

export async function measureStartup<T>(phase: CloudV2WorkerTiming["phase"], run: () => Promise<T>, observer?: StartupTimingObserver): Promise<T> {
  const started = performance.now();
  const result = await run();
  recordStartupTiming(phase, started, observer);
  return result;
}
