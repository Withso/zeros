import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";

export class DevProviderError extends Error {
  constructor(provider, status, requestId) {
    super(`${provider} request failed (${status}); the Dev receipt was preserved for retry`);
    this.status = status;
    this.provider = provider;
    this.requestId = /^[A-Za-z0-9_-]{1,100}$/.test(requestId ?? "") ? requestId : undefined;
  }
}

export const devCreateNotDispatched = receipt => ["planned", "rejected"].includes(receipt?.create?.phase);

/** Only an authenticated API's 401/403 denial is classified as not applied
 * (RFC 9110 sections 15.5.2/15.5.4). Conflicts, quota/validation errors, generic
 * GraphQL errors, timeouts and lost bodies remain uncertain, never age out. */
export async function dispatchDevCreate(lease, receipt, provider, dispatch, { key = "create", idempotentReplay = false } = {}) {
  let journal = receipt[key];
  const replay = idempotentReplay && (!journal || !["planned", "rejected"].includes(journal.phase));
  if (journal && !["planned", "rejected"].includes(journal.phase) && !idempotentReplay) throw new Error("Dev create is unconfirmed; use dev:reconcile before redispatch");
  if (!journal || journal.phase === "rejected") {
    journal = receipt[key] = { version: 1, id: randomUUID(), phase: replay ? "uncertain" : "planned", attempt: (journal?.attempt ?? 0) + 1, plannedAt: new Date().toISOString() };
    await lease.save();
  }
  await lease.fence();
  // A replay's denial says nothing about the original dispatch. Preserve its
  // outcome/time/key and record replay evidence separately, including crashes.
  const attempt = replay ? (journal.replay = { attempt: (journal.replay?.attempt ?? 0) + 1 }) : journal;
  attempt.phase = "dispatching"; attempt.dispatchedAt = new Date().toISOString(); await lease.save();
  try {
    const value = await dispatch();
    attempt.phase = "acknowledged"; attempt.acknowledgedAt = new Date().toISOString();
    journal.phase = "acknowledged"; journal.acknowledgedAt = attempt.acknowledgedAt; await lease.save();
    return value;
  } catch (error) {
    attempt.phase = error instanceof DevProviderError && error.provider === provider && [401, 403].includes(error.status) ? "rejected" : "uncertain";
    attempt.outcome = typeof error?.status === "number" ? error.status : "unavailable";
    if (error?.requestId) attempt.requestId = error.requestId;
    if (replay && journal.phase !== "acknowledged") journal.phase = "uncertain";
    await lease.save(); throw error;
  }
}

export async function acknowledgeDevCreate(lease, receipt, key = "create") {
  if (receipt[key] && receipt[key].phase !== "acknowledged") {
    receipt[key].phase = "acknowledged"; receipt[key].reconciledAt = new Date().toISOString(); await lease.save();
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
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("cf-ray");
    return { status: response.status, body, ...(/^[A-Za-z0-9_-]{1,100}$/.test(requestId ?? "") ? { requestId } : {}) };
  } catch (error) { throw error instanceof DevProviderError ? error : new DevProviderError(provider, "response unavailable"); }
  finally { await reader?.cancel().catch(() => {}); }
}

/** Provider builds normally finish in minutes, but degraded periods can take
 * far longer. A retry cancels the in-flight build, so waiting is the only way
 * a slow deployment converges. */
export const DEPLOYMENT_TIMEOUT_MS = 30 * 60_000;

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
