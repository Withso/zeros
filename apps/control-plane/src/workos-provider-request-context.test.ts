import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithWorkOSRequestSignal, withWorkOSRequestSignal } from "./workos-provider-request-context.js";
import { withHeldWorkOSProviderLock } from "./workos-provider-lock-context.js";

afterEach(() => vi.unstubAllGlobals());

describe("WorkOS list request cancellation", () => {
  it("cancels the network request and prevents a queued SDK retry", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | null | undefined;
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      observed = init?.signal;
      controller.abort();
      return new Response("{}", { status: 503 });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(withWorkOSRequestSignal(controller.signal, async () => {
      await expect(fetchWithWorkOSRequestSignal("https://provider.example.test/sessions")).rejects.toThrow();
      await fetchWithWorkOSRequestSignal("https://provider.example.test/sessions");
    })).rejects.toThrow();
    expect(observed?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps sibling requests independent and retains the enclosing provider-lock fence", async () => {
    const request = new AbortController(), heldLock = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response("{}");
    }));
    await withHeldWorkOSProviderLock(heldLock.signal, () => withWorkOSRequestSignal(request.signal,
      () => fetchWithWorkOSRequestSignal("https://provider.example.test/sessions")));
    await fetchWithWorkOSRequestSignal("https://provider.example.test/sessions");
    heldLock.abort();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted ?? false).toBe(false);
    expect(request.signal.aborted).toBe(false);
  });
});
