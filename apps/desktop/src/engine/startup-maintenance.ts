import { setImmediate as yieldToEventLoop } from "node:timers/promises";

type MaintenanceName = "archive-refs" | "branch-refs" | "design-acls";

interface MaintenanceTask {
  name: MaintenanceName;
  run: (signal: AbortSignal) => Promise<unknown>;
}

/** Optional janitors run after readiness, one at a time. Shutdown retires the
 * queue before joining the current task, so no work outlives its engine/DB. */
export function startStartupMaintenance(tasks: readonly MaintenanceTask[]): {
  stop(): Promise<void>;
} {
  const controller = new AbortController();
  const { signal } = controller;
  const done = (async () => {
    for (const task of tasks) {
      await yieldToEventLoop();
      if (signal.aborted) break;
      const started = performance.now();
      try {
        await task.run(signal);
        const elapsed = Math.round(performance.now() - started);
        if (!signal.aborted && elapsed >= 200) {
          console.log(`[Zeros] startup maintenance ${task.name}=${elapsed}ms`);
        }
      } catch {
        if (!signal.aborted) {
          // Errors can contain local paths or Git arguments. The closed phase
          // identifies the retry without exporting repository/user data.
          console.warn(`[Zeros] startup maintenance ${task.name} deferred until next launch`);
        }
      }
    }
  })();
  return {
    stop() {
      controller.abort();
      return done;
    },
  };
}
