import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";

export const DEFAULT_SLOW_REQUEST_LOG_MS = 1000;

type RequestTimingState = { transactions: number; heldMs: number; waitMs: number; closed: boolean };

const active = new AsyncLocalStorage<RequestTimingState>();

/** Attribute one shared-helper transaction to the request being served: its
 * pool wait, and the remaining time it held the connection. Work outside a
 * request (background loops) and work that outlives the logged request
 * (detached stream callbacks, timers) is not counted. */
export function recordTransactionTiming(waitMs: number, totalMs: number): void {
  const timing = active.getStore();
  if (!timing || timing.closed) return;
  timing.transactions += 1;
  timing.waitMs += waitMs;
  timing.heldMs += Math.max(0, totalMs - waitMs);
}

/** Attribute a pool wait that ended without a connection, such as an acquire
 * timeout under pool saturation. */
export function recordPoolWait(waitMs: number): void {
  const timing = active.getStore();
  if (!timing || timing.closed) return;
  timing.waitMs += waitMs;
}

/** Log requests slower than `slowMs` once, by the template of the route that
 * handled them rather than the raw path, so identifiers and query strings
 * never enter operational logs. `txMs` and `waitMs` are sums over the
 * request's helper transactions and can exceed wall time when they overlap.
 * Streaming responses are timed until their handler returns. */
export function requestTiming(options: {
  slowMs: number;
  log?: (line: string) => void;
}): MiddlewareHandler {
  const log = options.log ?? ((line: string) => console.warn(line));
  return async (c, next) => {
    const timing: RequestTimingState = { transactions: 0, heldMs: 0, waitMs: 0, closed: false };
    const started = performance.now();
    let failed = false;
    try {
      await active.run(timing, next);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      timing.closed = true;
      const ms = performance.now() - started;
      if (ms >= options.slowMs) {
        const method = /^[A-Z]{3,7}$/.test(c.req.method) ? c.req.method : "OTHER";
        const status = !failed && c.finalized ? String(c.res.status) : "error";
        log(
          `[http] slow ${method} ${routePath(c) || "unmatched"} ${status} ${Math.round(ms)}ms ` +
            `tx=${timing.transactions} txMs=${Math.round(timing.heldMs)} waitMs=${Math.round(timing.waitMs)}`,
        );
      }
    }
  };
}
