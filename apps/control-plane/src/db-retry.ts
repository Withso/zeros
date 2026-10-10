import type pg from "pg";
import { withSystemTx, type Tx } from "./db.js";

const RETRY_DELAYS_MS = [50, 150] as const;
const RETRY_BUDGET_MS = 1000;

/** These PostgreSQL outcomes confirm that the transaction did not commit.
 * Connection loss, constraints and generic retryable metadata do not. */
export function isDatabaseTransactionRollback(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "40P01" || error.code === "40001";
}

/** Opt in only for a complete DB-only transaction. Each attempt must finish
 * rollback/release before rejecting and re-read authority in its own context.
 * Never pass provider/network I/O or a whole reconciliation operation here. */
export async function retryAbortedDatabaseTransaction<T>(
  transaction: () => Promise<T>,
  options: { deadlineAt?: number } = {},
): Promise<T> {
  if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt))
    throw new Error("Invalid database transaction retry deadline");
  const deadline = Math.min(Date.now() + RETRY_BUDGET_MS, options.deadlineAt ?? Infinity);
  for (let attempt = 0; ; attempt++) {
    try {
      return await transaction();
    } catch (error) {
      const baseDelay = RETRY_DELAYS_MS[attempt];
      if (!isDatabaseTransactionRollback(error) || baseDelay === undefined) throw error;
      const delay = baseDelay + Math.floor(Math.random() * 50);
      if (Date.now() + delay >= deadline) throw error;
      // The rejected transaction has already rolled back/released; no lock or
      // checked-out connection is held across backoff.
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      if (Date.now() >= deadline) throw error;
    }
  }
}

export function withRetryableSystemTx<T>(
  pool: pg.Pool,
  fn: (tx: Tx) => Promise<T>,
  options: { deadlineAt?: number } = {},
): Promise<T> {
  return retryAbortedDatabaseTransaction(() => withSystemTx(pool, fn), options);
}
