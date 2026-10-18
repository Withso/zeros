import { AsyncLocalStorage } from "node:async_hooks";
import { fetchWithHeldWorkOSProviderLock } from "./workos-provider-lock-context.js";

// The SDK has no per-list request signal. Scope cancellation to this async
// request (including retries), without asserting or changing DB lock ownership.
const requests = new AsyncLocalStorage<AbortSignal>();

export async function withWorkOSRequestSignal<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (!signal) return work();
  const parent = requests.getStore();
  return requests.run(parent ? AbortSignal.any([parent, signal]) : signal, async () => {
    requests.getStore()!.throwIfAborted();
    const result = await work();
    requests.getStore()!.throwIfAborted();
    return result;
  });
}

export const fetchWithWorkOSRequestSignal: typeof fetch = async (input, init) => {
  const signal = requests.getStore();
  signal?.throwIfAborted();
  const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const response = await fetchWithHeldWorkOSProviderLock(input, signal ? {
    ...init, signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
  } : init);
  if (signal?.aborted) {
    await response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  return response;
};
