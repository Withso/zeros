import { executionUnavailable } from "./errors.js";

export const EXECUTION_LEASE_MS = 30_000;
// Two 10 s renewal intervals plus 5 s for transit. Time spent acquiring locks
// or material consumes this budget; it never moves the proof's deadline.
export const EXECUTION_MINIMUM_LIFETIME_MS = 25_000;
export function assertExecutionLifetime(until: number) {
  if (!Number.isFinite(until) || until - Date.now() < EXECUTION_MINIMUM_LIFETIME_MS) throw executionUnavailable();
}
