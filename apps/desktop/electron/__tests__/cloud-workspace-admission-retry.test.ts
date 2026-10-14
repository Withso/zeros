import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudWorkspaceAccessClient, CloudWorkspaceAccessClientError } from "../cloud-workspace-access-client";
import { CloudWorkspaceAccessBroker } from "../cloud-workspace-access-broker";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";
const engineInstanceId = "44444444-4444-4444-8444-444444444444";
const target = { organizationId, workspaceId };
const code = "cloud_runtime_temporarily_unavailable";
const failure = { status: 503, code, phase: "provider_endpoint", retryAfterMs: 1000 };
const privateText = "synthetic-private-provider-body";

function unavailable(options: { status?: number; header?: string | null; error?: Record<string, unknown> } = {}) {
  return Response.json({ error: { code, phase: "provider_endpoint", retryable: true, message: privateText, details: privateText, ...options.error } },
    { status: options.status ?? 503, headers: options.header === null ? {} : { "Retry-After": options.header ?? "1" } });
}
function grant(generation = 7) {
  return { version: 2, audience: "zeros-cloud-workspace-engine-client-admission-v2", ...target,
    generation, authorityEpoch: 11, engineInstanceId, remotePort: 47891, grantToken: `zwa_${"a".repeat(43)}`,
    expiresAt: new Date(Date.now() + 120_000).toISOString(), bridgeUrl: "wss://api.zeros.test/v1/cloud-workspaces/bridge" };
}
function fixture() {
  let proofNumber = 0;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => init?.method === "DELETE"
    ? new Response(null, { status: 204 }) : Response.json(grant(), { status: 201 }));
  const signer = vi.fn(async (_token: string, _target: typeof target) => ({ deviceId, keyVersion: 1, timestampMs: Date.now(),
    nonce: `nonce_${String(++proofNumber).padStart(20, "0")}`, signature: "s".repeat(86) }));
  const client = new CloudWorkspaceAccessClient({ baseUrl: "https://api.zeros.test", fetch: fetcher,
    now: () => Date.now(), monotonic: () => Date.now(), signEngineAdmission: signer });
  const onAdmissionFailure = vi.fn(), onAdmissionRetry = vi.fn();
  return { client, fetcher, signer, onAdmissionFailure, onAdmissionRetry,
    options: { onAdmissionFailure, onAdmissionRetry } };
}
const observed = <T>(promise: Promise<T>) => promise.then(value => ({ value }), error => ({ error }));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.useRealTimers(); });

describe("concrete admission response and retry boundary", () => {
  it("honors each delay, signs each request afresh and keeps only the closed first failure", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(unavailable({ header: "2" }));
    const result = observed(f.client.issueEngineAdmission("fixture-account-token", target, f.options));
    await vi.advanceTimersByTimeAsync(999);
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.onAdmissionRetry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999); expect(f.fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ value: { generation: 7 } });
    expect(f.signer).toHaveBeenCalledTimes(3);
    const nonces = f.fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get("x-zeros-device-nonce"));
    expect(new Set(nonces).size).toBe(3);
    expect(f.onAdmissionFailure.mock.calls).toEqual([[failure], [{ ...failure, retryAfterMs: 2000 }]]);
    expect(f.onAdmissionRetry.mock.calls).toEqual([[{ ...failure, attempt: 2, delayMs: 1000 }],
      [{ ...failure, retryAfterMs: 2000, attempt: 3, delayMs: 2000 }]]);
    expect(JSON.stringify([f.onAdmissionRetry.mock.calls, f.onAdmissionFailure.mock.calls])).not.toContain(privateText);
  });

  it("stops after two retries and preserves strictly parsed advice with fixed public text", async () => {
    const f = fixture(); f.fetcher.mockImplementation(async () => unavailable());
    const result = observed(f.client.issueEngineAdmission("fixture-account-token", target, f.options));
    await vi.advanceTimersByTimeAsync(2000);
    const value = await result;
    expect(value).toMatchObject({ error: { status: 503, code, phase: "provider_endpoint", retryable: true, retryAfterMs: 1000 } });
    expect("error" in value && value.error).toBeInstanceOf(CloudWorkspaceAccessClientError);
    expect(JSON.stringify(value)).not.toContain(privateText);
    expect(f.fetcher).toHaveBeenCalledTimes(3); expect(f.onAdmissionRetry).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 500 }, { status: 401 }, { status: 403 }, { status: 429 },
    { error: { code: "internal" } }, { error: { code: "service_busy" } }, { error: { code: "cloud_access_provider_unavailable" } },
    { error: { retryable: false } }, { error: { retryable: "true" } }, { error: { retryable: null } },
    { error: { phase: "grant" } }, { error: { phase: "provider_host_key" } }, { error: { phase: "engine_reach" } },
    { error: { phase: privateText } }, { error: { phase: null } },
    { header: null }, { header: "0" }, { header: "301" }, { header: "-1" }, { header: "1.5" },
    { header: "1e0" }, { header: "01" }, { header: "1, 2" }, { header: "Wed, 14 Oct 2026 13:00:00 GMT" },
  ])("does not turn a lookalike error into retry authority: %j", async options => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(unavailable(options));
    const result = await observed(f.client.issueEngineAdmission("fixture-account-token", target, f.options));
    expect(result).toHaveProperty("error");
    expect("error" in result && result.error.retryable).toBeUndefined();
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.onAdmissionRetry).not.toHaveBeenCalled();
    expect(f.onAdmissionFailure).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain(privateText);
  });

  it("does not extend or clamp the original deadline when the advice no longer fits", async () => {
    const f = fixture(); let release!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const result = observed(f.client.issueEngineAdmission("fixture-account-token", target, f.options));
    await vi.advanceTimersByTimeAsync(14_000); release(unavailable({ header: "2" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toMatchObject({ error: { code: "request_timeout" } });
    expect(f.onAdmissionFailure).toHaveBeenCalledWith({ ...failure, retryAfterMs: 2000 });
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.onAdmissionRetry).not.toHaveBeenCalled();
    expect(Date.now()).toBe(1_800_000_014_000);
  });

  it("accepts bounded advice as evidence but never waits 300 seconds in a 15-second operation", async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(unavailable({ header: "300" }));
    const result = await observed(f.client.issueEngineAdmission("fixture-account-token", target, f.options));
    expect(result).toMatchObject({ error: { code: "request_timeout" } });
    expect(f.onAdmissionFailure).toHaveBeenCalledWith({ ...failure, retryAfterMs: 300_000 });
    expect(f.onAdmissionRetry).not.toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("cancels backoff on the original caller signal without a second proof or request", async () => {
    const f = fixture(), controller = new AbortController(); f.fetcher.mockResolvedValueOnce(unavailable());
    const result = observed(f.client.issueEngineAdmission("fixture-account-token", target, { ...f.options, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ error: { code: "request_timeout" } });
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.signer).toHaveBeenCalledOnce();
    expect(f.onAdmissionRetry).not.toHaveBeenCalled(); expect(f.onAdmissionFailure).toHaveBeenCalledOnce();
  });

  it("includes a stalled signer in the original deadline and never sends its late proof", async () => {
    const f = fixture(); let release!: (value: Awaited<ReturnType<typeof f.signer>>) => void;
    const proof = await f.signer("fixture-account-token", target); f.signer.mockClear();
    f.signer.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const result = observed(f.client.issueEngineAdmission("fixture-account-token", target, f.options));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ error: { code: "request_timeout" } });
    release(proof); await vi.advanceTimersByTimeAsync(0); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["deadline", "abort"] as const)("counts a retry at dispatch when its observer triggers %s", async action => {
    const f = fixture(), controller = new AbortController(), dispatched: number[] = [];
    f.fetcher.mockResolvedValueOnce(unavailable());
    const onAdmissionRetry = vi.fn(() => {
      dispatched.push(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST").length);
      if (action === "deadline") vi.setSystemTime(1_800_000_015_000);
      else controller.abort();
    });
    const result = observed(f.client.issueEngineAdmission("fixture-account-token", target,
      { ...f.options, signal: controller.signal, onAdmissionRetry }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ error: { code: "request_timeout" } });
    expect(dispatched).toEqual([2]);
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect(onAdmissionRetry).toHaveBeenCalledOnce();
  });

  it("bounds an unresponsive response body and never retries an unknown transport result", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start() {} }), { status: 503, headers: { "Retry-After": "1" } }));
    const result = observed(f.client.issueEngineAdmission("fixture-account-token", target, f.options));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ error: { code: "request_timeout" } });
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.onAdmissionRetry).not.toHaveBeenCalled();
  });

  it("retires a valid late grant after cancellation even when transport ignored its signal", async () => {
    const f = fixture(), controller = new AbortController(); let release!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const result = observed(f.client.issueEngineAdmission("fixture-account-token", target, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect(await result).toMatchObject({ error: { code: "request_timeout" } });
    release(Response.json(grant(), { status: 201 })); await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect(f.signer).toHaveBeenCalledOnce();
  });

  it("never retries a subsequent unknown fault and cannot be redirected by a mutated input", async () => {
    const f = fixture(), input = { ...target };
    f.fetcher.mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(unavailable({ status: 500, error: { code: "internal", retryable: false } }));
    const result = observed(f.client.issueEngineAdmission("fixture-account-token", input, f.options));
    await vi.advanceTimersByTimeAsync(0); input.organizationId = deviceId;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ error: { status: 500, code: "request_failed" } });
    expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.onAdmissionFailure).toHaveBeenCalledOnce();
    expect(f.signer.mock.calls).toEqual([["fixture-account-token", target], ["fixture-account-token", target]]);
  });
});

describe("broker ownership and Stop fences during admission retries", () => {
  function access() {
    const f = fixture(); let account = "fixture/account-a";
    const broker = new CloudWorkspaceAccessBroker({ api: f.client, getAccessToken: async () => "fixture-account-token",
      getAccountSessionKey: () => account, now: () => Date.now() });
    return { ...f, broker, replaceAccount: () => { account = "fixture/account-b"; } };
  }
  it.each(["account", "dispose", "signal"] as const)("stops a pending open when %s retires its authority", async action => {
    const f = access(), controller = new AbortController(); f.fetcher.mockResolvedValueOnce(unavailable());
    const result = observed(f.broker.openRuntime(target, { signal: controller.signal, ...f.options }));
    await vi.advanceTimersByTimeAsync(0);
    if (action === "account") f.replaceAccount();
    else if (action === "dispose") await f.broker.dispose();
    else controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toHaveProperty("error"); expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.signer).toHaveBeenCalledOnce();
    expect(f.onAdmissionFailure).toHaveBeenCalledOnce(); expect(f.onAdmissionRetry).not.toHaveBeenCalled();
    await f.broker.dispose();
  });
  it("does not mint another refresh grant after Stop closes that exact runtime", async () => {
    const f = access(), first = await f.broker.openRuntime(target);
    f.fetcher.mockResolvedValueOnce(unavailable());
    const result = observed(f.broker.refreshRuntime(first));
    await vi.advanceTimersByTimeAsync(0); await f.broker.closeRuntime(first.runtimeId);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ error: { code: "cloud_workspace_access_superseded" } });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    expect(f.signer).toHaveBeenCalledTimes(2); await f.broker.dispose();
  });
  it("retires a changed-generation grant returned after a retry instead of publishing it", async () => {
    const bound = (generation: number) => ({ ...grant(generation), grantToken: `zwa_${String(generation).repeat(43)}`,
      bootScope: { ...target, generation, engineInstanceId, bootId: deviceId, writerEpoch: organizationId,
        fundingOwnerUserId: workspaceId, fundingOwnerEpoch: 1 } });
    const f = access(); f.fetcher.mockResolvedValueOnce(Response.json(bound(7), { status: 201 }));
    const first = await f.broker.openRuntime(target);
    f.fetcher.mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(Response.json(bound(8), { status: 201 }));
    const result = observed(f.broker.refreshRuntime(first)); await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ error: { code: "cloud_workspace_access_superseded" } });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    await f.broker.dispose();
  });
});
