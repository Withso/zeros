import { describe, expect, it, vi } from "vitest";
import { BoatApiClient } from "./boat-client.js";

function fixture() {
  const fetcher = vi.fn<typeof fetch>();
  return {
    fetcher,
    client: new BoatApiClient({
      apiKey: "boat_test-only-credential",
      timeoutMs: 1000,
      fetch: fetcher,
    }),
  };
}
describe("Boat API boundary", () => {
  it.each([
    "short",
    "boat_credential_with_é",
    "boat_credential_with_\nnewline",
  ])(
    "rejects malformed credentials before constructing request headers",
    (apiKey) => {
      const fetcher = vi.fn<typeof fetch>();
      expect(
        () => new BoatApiClient({ apiKey, timeoutMs: 1000, fetch: fetcher }),
      ).toThrow("Invalid Boat credential");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("pins the credential destination and forbids redirects", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(Response.json({ ok: true }));
    await f.client.request("/sandboxes", {
      method: "POST",
      body: { noEnv: true },
    });
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(url).toBe("https://boat.dev/api/v1/sandboxes");
    expect(init!.redirect).toBe("error");
    expect(new Headers(init!.headers).get("authorization")).toBe(
      "Bearer boat_test-only-credential",
    );
    for (const path of [
      "//attacker.example/",
      "/../me",
      "/sandboxes#fragment",
      "https://attacker.example/",
    ]) {
      await expect(f.client.request(path)).rejects.toThrow(
        "Invalid Boat API path",
      );
    }
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("bounds streamed response bytes", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1)));
    await expect(f.client.request("/sandboxes")).rejects.toMatchObject({
      code: "provider_response_too_large",
      retryable: false,
    });
  });
  it.each([
    [401, false],
    [402, false],
    [429, true],
    [503, true],
    [409, false],
  ])(
    "normalizes HTTP %s without retaining provider secrets",
    async (status, retryable) => {
      const f = fixture();
      f.fetcher.mockResolvedValue(
        Response.json(
          {
            ok: false,
            message: "secret-account-token",
            code: "sensitive-error",
          },
          { status: status as number },
        ),
      );
      const error = await f.client
        .request("/sandboxes")
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ retryable });
      expect(String(error)).not.toContain("secret-account-token");
      expect(String(error)).not.toContain("sensitive-error");
    },
  );
  it("retries an in-progress duplicate create and bounds Retry-After", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      Response.json(
        { ok: false, code: "idempotency_in_progress" },
        { status: 409, headers: { "retry-after": "999999" } },
      ),
    );
    await expect(f.client.request("/sandboxes")).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 300_000,
    });
  });
  it("treats the trial's total compute cap as exhausted budget even when HTTP reports 429", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(Response.json({ok:false,code:"trial_compute_limit_reached",message:"private provider account details"},{status:429}));
    const error = await f.client.request("/sandboxes").catch((error: unknown) => error);
    expect(error).toMatchObject({code:"provider_budget_exhausted",retryable:false});
    expect(String(error)).not.toContain("private provider account details");
  });
});
