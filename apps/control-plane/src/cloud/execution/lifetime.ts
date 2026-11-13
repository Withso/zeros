import { ExecutionContextEnded, executionUnavailable } from "./errors.js";
import { HttpError } from "../../authz.js";

export const EXECUTION_LEASE_MS = 30_000;
// Two 10 s renewal intervals plus 5 s for transit. Time spent acquiring locks
// or material consumes this budget; it never moves the proof's deadline.
export const EXECUTION_MINIMUM_LIFETIME_MS = 25_000;
export class ExecutionLifetimeUnavailable extends HttpError {
  constructor() {
    const error = executionUnavailable();
    super(error.status, error.code, error.message);
  }
}
export function assertExecutionLifetime(until: number, tokenEnd?: number) {
  const now = Date.now();
  if (tokenEnd !== undefined && tokenEnd <= now) throw new ExecutionContextEnded("expired");
  // A live client may use the remaining token tail while its authenticated
  // rollover is in flight. That hard ceiling never extends source authority.
  const floor = tokenEnd === undefined ? EXECUTION_MINIMUM_LIFETIME_MS : Math.min(EXECUTION_MINIMUM_LIFETIME_MS, tokenEnd - now);
  if (!Number.isFinite(until) || until - now < floor) throw new ExecutionLifetimeUnavailable();
}

/** The attempt owns its transaction. Only a rolled-back lifetime refusal may
 * obtain new authority; credential failures and uncertain commits never retry. */
export async function withExecutionLifetimeRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try { return await attempt(); }
  catch (error) {
    if (!(error instanceof ExecutionLifetimeUnavailable)) throw error;
    return attempt();
  }
}
