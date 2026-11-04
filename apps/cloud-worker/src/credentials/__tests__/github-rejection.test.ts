import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { GithubCredentialRecovery } from "../github-recovery";
import { GithubBroker, GithubTokens, githubTokenHash, type GithubTokenRequest } from "../github";
import { githubAuthenticationError } from "../github-failure";
import { brokerRequest } from "../client";

afterEach(() => vi.useRealTimers());
function fixture(statuses: number[], supported = true) {
  const get = vi.fn(async (request: GithubTokenRequest) => ({ token: request.failedTokenSha256 ? "fixture-fresh-user" : "fixture-first-user", expiresAt: Date.now() + 120_000 }));
  const invalidate = vi.fn();
  const fetcher = vi.fn(async () => new Response(null, { status: statuses.shift() ?? 200 }));
  const recovery = new GithubCredentialRecovery({ get, invalidate }, { fetch: fetcher, supportsRecovery: () => supported });
  return { recovery, get, invalidate, fetcher };
}
it("recovers one typed GitHub 401 before handing a token to git or gh", async () => {
  for (const purpose of ["git", "gh"] as const) {
    const f = fixture([401, 200]);
    const token = await f.recovery.get(purpose);
    expect(token.token).toBe("fixture-fresh-user");
    expect(f.get).toHaveBeenCalledTimes(2);
    expect(f.get.mock.calls[1]?.[0]).toMatchObject({ purpose, failedTokenSha256: githubTokenHash("fixture-first-user") });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  }
});
it("coalesces validation and limits repeated checks of the same token to once per three minutes", async () => {
  vi.useFakeTimers();
  const f = fixture([200]);
  await Promise.all([f.recovery.get("git"), f.recovery.get("gh")]);
  expect(f.get).toHaveBeenCalledOnce();
  expect(f.fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(179_999);
  await f.recovery.get("gh");
  expect(f.fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await f.recovery.get("git");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it.each([403, 429, 500])("hands off an unverified credential and backs off for a minute on HTTP %s", async status => {
  vi.useFakeTimers();
  const f = fixture([status, 200]);
  if (status === 403) f.fetcher.mockImplementationOnce(async () => new Response(null, { status, headers: { "x-ratelimit-remaining": "0" } }));
  expect((await f.recovery.get("gh")).token).toBe("fixture-first-user");
  expect(f.get).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(59_999);
  await f.recovery.get("gh");
  expect(f.fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await f.recovery.get("git");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.invalidate).not.toHaveBeenCalled();
  expect(f.get.mock.calls.every(([request]) => !request.failedTokenSha256)).toBe(true);
});
it("hands off an unverified credential during a network outage without checking every command", async () => {
  vi.useFakeTimers();
  const f = fixture([200]);
  f.fetcher.mockRejectedValueOnce(new TypeError("synthetic network failure"));
  expect((await f.recovery.get("git")).token).toBe("fixture-first-user");
  await vi.advanceTimersByTimeAsync(59_999);
  await f.recovery.get("gh");
  expect(f.fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await f.recovery.get("git");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.invalidate).not.toHaveBeenCalled();
});
it("lets a slow advisory check time out before the caller's deadline and hand off its credential", async () => {
  vi.useFakeTimers();
  const started = Date.now(), f = fixture([200]);
  f.get.mockImplementationOnce(async () => {
    vi.setSystemTime(started + 19_500);
    return { token: "fixture-first-user", expiresAt: Date.now() + 120_000 };
  });
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  f.fetcher.mockImplementationOnce((...args: unknown[]) => new Promise((_resolve, reject) => {
    const signal = (args[1] as RequestInit).signal!;
    signal.addEventListener("abort", () => reject(new Error("synthetic timeout")), { once: true });
  }));
  try {
    const pending = f.recovery.get("git").then(value => ({ token: value.token, at: Date.now() }), error => ({ error: error.reason }));
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;
    expect(result).toMatchObject({ token: "fixture-first-user" });
    expect("at" in result && result.at! - started).toBeLessThan(20_000);
    await f.recovery.get("gh");
    expect(f.fetcher).toHaveBeenCalledOnce();
  } finally { timeout.mockRestore(); }
});
it("never caches an authoritative control-plane refusal as an advisory validation backoff", async () => {
  const f = fixture([200]);
  f.get.mockRejectedValueOnce(githubAuthenticationError("source-review-required"));
  await expect(f.recovery.get("git")).rejects.toMatchObject({ reason: "source-review-required" });
  expect((await f.recovery.get("git")).token).toBe("fixture-first-user");
  expect(f.get).toHaveBeenCalledTimes(2);
  expect(f.fetcher).toHaveBeenCalledOnce();
});
it("ends a second 401 without a third request or a cached rejected token", async () => {
  const f = fixture([401, 401]);
  await expect(f.recovery.get("git")).rejects.toMatchObject({ reason: "connection-expired" });
  expect(f.get).toHaveBeenCalledTimes(2);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.invalidate).toHaveBeenCalled();
});
it("uses legacy human purpose without sending an unsupported failure field to an older control plane", async () => {
  const f = fixture([401], false);
  await expect(f.recovery.get("git")).rejects.toMatchObject({ reason: "connection-expired" });
  expect(f.get.mock.calls.every(([request]) => request.purpose === "gh" && !request.failedTokenSha256)).toBe(true);
  expect(f.fetcher).toHaveBeenCalledOnce();
});
it("reports an in-command rejection once, even inside the validation interval", async () => {
  const f = fixture([200, 200]);
  await f.recovery.get("git");
  const failed = githubTokenHash("fixture-first-user");
  const [a, b] = await Promise.all([f.recovery.get("git", failed), f.recovery.get("gh", failed)]);
  expect(a).toEqual(b);
  expect(f.get).toHaveBeenCalledTimes(2);
  expect(f.get.mock.calls[1]?.[0].failedTokenSha256).toBe(failed);
});
it("keeps plain waiters through concurrent unrelated and matching rejection reports", async () => {
  const f = fixture([200]);
  let finish!: (value: Response) => void;
  f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const settled = (value: ReturnType<typeof f.recovery.get>) => value.then(token => ({ token: token.token }), error => ({ error: error.reason }));
  const plain = settled(f.recovery.get("git"));
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  const unrelated = settled(f.recovery.get("gh", githubTokenHash("fixture-retired-human")));
  const matching = settled(f.recovery.get("git", githubTokenHash("fixture-first-user")));
  finish(new Response(null, { status: 200 }));
  expect(await Promise.all([plain, unrelated, matching])).toEqual([
    { token: "fixture-fresh-user" }, { token: "fixture-fresh-user" }, { token: "fixture-fresh-user" },
  ]);
  expect(f.get).toHaveBeenCalledTimes(2);
  expect(f.get.mock.calls[1]?.[0].failedTokenSha256).toBe(githubTokenHash("fixture-first-user"));
});
it("fences a delayed validation after the selected connection changes", async () => {
  const f = fixture([200]);
  let finish!: (value: Response) => void;
  f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.recovery.get("git").then(value => ({ value }), error => ({ error }));
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  f.recovery.invalidate(); finish(new Response(null, { status: 200 }));
  expect(await pending).toMatchObject({ error: { reason: "connection-changed" } });
  await f.recovery.get("git");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("withholds a pre-disconnect credential and keeps the broker waiter until fresh acquisition after reconnect", async () => {
  let requests = 0, finish!: (value: Response) => void, settled = false;
  const tokens = new GithubTokens(async frame => {
    if (frame.t === "request") tokens.receive({ t: "reply", id: frame.id, token: `fixture-connection-${++requests}`, expiresAt: Date.now() + 120_000 });
    return true;
  });
  const get = vi.spyOn(tokens, "get");
  const fetcher = vi.fn(async () => new Response(null, { status: 200 }))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const recovery = new GithubCredentialRecovery(tokens, { fetch: fetcher, supportsRecovery: () => true });
  const broker = new GithubBroker(`/tmp/zeros-github-${randomUUID()}/github.sock`, (purpose, failed) => recovery.get(purpose, failed));
  tokens.connect(); await broker.start();
  try {
    const pending = brokerRequest(broker.socketPath, "token").then(value => { settled = true; return value; }, error => { settled = true; return { error }; });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    tokens.disconnect(); recovery.disconnect();
    finish(new Response(null, { status: 200 }));
    await vi.waitFor(() => expect(settled || get.mock.calls.length >= 2).toBe(true));
    expect(settled).toBe(false);
    expect(requests).toBe(1);
    tokens.connect();
    expect(await pending).toMatchObject({ token: "fixture-connection-2" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { tokens.dispose(); await broker.dispose(); }
});
it("keeps token refresh and the second preflight inside the original twenty-second budget", async () => {
  vi.useFakeTimers();
  const f = fixture([401, 200]);
  f.get.mockImplementationOnce(async request => {
    expect(request.timeoutMs).toBe(20_000);
    vi.setSystemTime(Date.now() + 17_000);
    return { token: "fixture-first-user", expiresAt: Date.now() + 120_000 };
  }).mockImplementationOnce(async request => {
    expect(request.timeoutMs).toBe(3000);
    vi.setSystemTime(Date.now() + 2500);
    return { token: "fixture-fresh-user", expiresAt: Date.now() + 120_000 };
  });
  const timeout = vi.spyOn(AbortSignal, "timeout");
  try {
    await f.recovery.get("git");
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([2900, 400]);
  } finally { timeout.mockRestore(); }
});
