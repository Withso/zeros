import { AsyncLocalStorage } from "node:async_hooks";

/** Also fences nested database work after a session-lock connection is lost.
 * A failed external HTTP response remains uncertain; this guard never retries
 * the provider operation or claims to undo a request already delivered. */
const heldLocks = new AsyncLocalStorage<AbortSignal>();
export class WorkOSProviderLockLostError extends Error {
  readonly code = "workos_provider_lock_lost";
  constructor() {
    super("WorkOS provider lock ownership was lost");
    this.name = "WorkOSProviderLockLostError";
  }
}
export function assertWorkOSProviderLockHeld(): void {
  heldLocks.getStore()?.throwIfAborted();
}
/** Applied at the SDK fetch seam, including SDK retries. A queued retry cannot
 * send another external mutation after the database lock has been retired. */
export const fetchWithHeldWorkOSProviderLock: typeof fetch = async (
  input,
  init,
) => {
  const signal = heldLocks.getStore();
  assertWorkOSProviderLockHeld();
  const requestSignal =
    init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const response = await fetch(
    input,
    signal
      ? {
          ...init,
          signal: requestSignal
            ? AbortSignal.any([signal, requestSignal])
            : signal,
        }
      : init,
  );
  if (signal?.aborted) {
    await response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  return response;
};
export function withHeldWorkOSProviderLock<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  const parent = heldLocks.getStore();
  return heldLocks.run(
    parent ? AbortSignal.any([parent, signal]) : signal,
    async () => {
      assertWorkOSProviderLockHeld();
      const result = await work();
      assertWorkOSProviderLockHeld();
      return result;
    },
  );
}
