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
  it("scopes only an explicitly billed sandbox creation to the configured wallet", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const client = new BoatApiClient({
      apiKey: "boat_test-only-credential",
      timeoutMs: 1000,
      billingOrg: "team_0f5c2a9e-4b1d-4c8e-9a70-3d2b1e6f8c41",
      fetch: fetcher,
    });
    await client.request("/sandboxes", { method: "POST", body: { noEnv: true }, billingScope: true });
    await client.request("/sandboxes", { method: "POST", body: { noEnv: true } });
    await client.request("/sandboxes/bx_23456789/resume", { method: "POST", body: { ttlSeconds: 600 } });
    const headers = fetcher.mock.calls.map(([, init]) => new Headers(init!.headers));
    expect(headers[0]!.get("x-boat-org")).toBe("team_0f5c2a9e-4b1d-4c8e-9a70-3d2b1e6f8c41");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ noEnv: true });
    expect(headers[1]!.has("x-boat-org")).toBe(false);
    expect(headers[2]!.has("x-boat-org")).toBe(false);
    await expect(
      client.request("/sandboxes/bx_23456789/resume", { method: "POST", billingScope: true }),
    ).rejects.toThrow("Invalid Boat billing scope");
    await expect(
      fixture().client.request("/sandboxes", { method: "POST", billingScope: true }),
    ).rejects.toThrow("Invalid Boat billing scope");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    "Zeros",
    "team_",
    "team_0f5c2a9e-4b1d-4c8e-9a70-3d2b1e6f8c41\n",
    "TEAM_0F5C2A9E-4B1D-4C8E-9A70-3D2B1E6F8C41",
    "71526620-8a69-44ca-bbef-1a71267c4350",
  ])("rejects a malformed or personal billing wallet before any request: %j", (billingOrg) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      () => new BoatApiClient({ apiKey: "boat_test-only-credential", timeoutMs: 1000, billingOrg, fetch: fetcher }),
    ).toThrow("Invalid Boat billing organization");
    expect(fetcher).not.toHaveBeenCalled();
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

  it("retains only a qualified, request-bound create rejection", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(Response.json({
      ok: false, type: "sandbox.error", status: 429, requestId: "req_test_rejected_create",
      code: "trial_compute_limit_reached",
      error: { code: "trial_compute_limit_reached", status: 429, message: "private details" },
    }, { status: 429 }));
    const error = await f.client.request("/sandboxes", {
      method: "POST", body: {}, idempotencyKey: "test-attempt",
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ createRejectionCode: "trial_compute_limit_reached", retryable: false });
    expect(JSON.stringify(error)).not.toContain("private details");
  });

  it.each([
    { method: "GET" }, { path: "/sandboxes/bx_23456789/resume" },
    { httpStatus: 503 }, { code: "unqualified_error" }, { ok: true },
    { status: 200 }, { type: "sandbox.created" }, { sandbox: { id: "bx_23456789" } },
    { error: { code: "different_error", status: 429 } },
    { requestId: "" }, { requestId: "x".repeat(300) },
    { sandboxId: "bx_23456789" }, { operation: { id: "unexpected-allocation" } },
    { error: { code: "trial_compute_limit_reached", status: 429, details: { sandboxId: "bx_23456789" } } },
    { id: "bx_23456789" }, { message: { sandbox: { id: "bx_23456789" } } },
    { error: { code: "trial_compute_limit_reached", status: 429, sandbox: { id: "bx_23456789" } } },
    { error: { code: "trial_compute_limit_reached", status: 429, message: { operation: "accepted" } } },
    { error: { code: "trial_compute_limit_reached", status: 429, details: { newProviderField: true } } },
  ])("does not certify ambiguous or unrelated rejection evidence: %j", async (override) => {
    const f = fixture();
    const { method = "POST", path = "/sandboxes", httpStatus = 429, ...body } = override;
    f.fetcher.mockResolvedValue(Response.json({
      ok: false, type: "sandbox.error", status: 429, code: "trial_compute_limit_reached", requestId: "req_test_rejected_create",
      error: { code: "trial_compute_limit_reached", status: 429 }, ...body,
    }, { status: httpStatus }));
    const error = await f.client.request(path, {
      method: method as "POST" | "GET", idempotencyKey: "test-attempt",
    }).catch((error: unknown) => error);
    expect(error).not.toHaveProperty("createRejectionCode");
  });

  it("accepts the known bounded limit diagnostics without retaining their values", async () => {
    const f=fixture();
    f.fetcher.mockResolvedValue(Response.json({
      ok:false,type:"sandbox.error",status:429,code:"limit_reached",requestId:"req_test_limit",
      error:{code:"limit_reached",status:429,message:"private account",details:{
        currentLimits:{activeSandboxes:2,startsPerDay:75},maxActiveSandboxes:2,
        sandboxPlanTiers:[{key:"trial",dollars:0}],status:"blocked",
      }},
    },{status:429}));
    const error=await f.client.request("/sandboxes",{method:"POST",idempotencyKey:"known-limit"}).catch((value:unknown)=>value);
    expect(error).toMatchObject({createRejectionCode:"limit_reached",retryable:true});
    expect(JSON.stringify(error)).not.toContain("private account");
    expect(JSON.stringify(error)).not.toContain("currentLimits");
  });
});
