import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";

type RequestTimingState = { transactions: number; transactionMs: number; waitMs: number };

const active = new AsyncLocalStorage<RequestTimingState>();

/** Attribute one shared-helper transaction (pool wait plus total time) to the
 * request being served. Work outside a request, such as background loops, is
 * not counted. */
export function recordTransactionTiming(waitMs: number, totalMs: number): void {
  const timing = active.getStore();
  if (!timing) return;
  timing.transactions += 1;
  timing.waitMs += waitMs;
  timing.transactionMs += totalMs;
}

/** Log requests slower than `slowMs` once, by matched route template rather
 * than raw path, so identifiers and query strings never enter operational
 * logs. Streaming responses are timed until their handler returns. */
export function requestTiming(options: {
  slowMs: number;
  log?: (line: string) => void;
}): MiddlewareHandler {
  const log = options.log ?? ((line: string) => console.warn(line));
  return async (c, next) => {
    const timing: RequestTimingState = { transactions: 0, transactionMs: 0, waitMs: 0 };
    const started = performance.now();
    try {
      await active.run(timing, next);
    } finally {
      const ms = performance.now() - started;
      if (ms >= options.slowMs) {
        const route = matchedRoutes(c).findLast((match) => match.method !== "ALL")?.path ?? "unmatched";
        const method = /^[A-Z]{3,7}$/.test(c.req.method) ? c.req.method : "OTHER";
        log(
          `[http] slow ${method} ${route} ${c.res.status} ${Math.round(ms)}ms ` +
            `db=${timing.transactions}tx/${Math.round(timing.transactionMs)}ms wait=${Math.round(timing.waitMs)}ms`,
        );
      }
    }
  };
}
