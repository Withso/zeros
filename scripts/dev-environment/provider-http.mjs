import { setTimeout as sleep } from "node:timers/promises";

export class DevProviderError extends Error {
  constructor(provider, status) {
    super(`${provider} request failed (${status}); the Dev receipt was preserved for retry`);
    this.status = status;
  }
}

export async function providerJson(provider, url, options = {}, fetchImpl = fetch) {
  const { timeoutMs = 30_000, ...init } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 610_000) throw new Error("Invalid provider request deadline");
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "error",
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  } catch { throw new DevProviderError(provider, "unavailable"); }
  const reader = response.body?.getReader();
  const chunks = []; let size = 0;
  try {
    if (reader) for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 2 * 1024 * 1024) throw new DevProviderError(provider, "oversized response");
      chunks.push(value);
    }
    let body = null;
    if (size) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new DevProviderError(provider, "invalid response"); } }
    return { status: response.status, body };
  } catch (error) { throw error instanceof DevProviderError ? error : new DevProviderError(provider, "response unavailable"); }
  finally { await reader?.cancel().catch(() => {}); }
}

export async function pollProvider(label, check, { signal, timeout = 180_000, interval = 1500, now = Date.now, delay = sleep } = {}) {
  const deadline = now() + timeout;
  for (;;) {
    signal?.throwIfAborted();
    const result = await check();
    if (result) return result;
    if (now() >= deadline) throw new Error(`${label} has not completed; retry using the retained Dev receipt`);
    await delay(Math.min(interval, deadline - now()), undefined, { signal });
  }
}
