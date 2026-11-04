import { afterEach, expect, it, vi } from "vitest";
import { GithubCredentialRecovery } from "../github-recovery";
import { githubTokenHash, type GithubTokenRequest } from "../github";

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
it.each([403, 429, 500])("does not rotate a token or cache a refusal on HTTP %s", async status => {
  const f = fixture([status, 200]);
  await expect(f.recovery.get("gh")).rejects.toThrow();
  expect(f.get).toHaveBeenCalledOnce();
  await f.recovery.get("gh");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.get.mock.calls.every(([request]) => !request.failedTokenSha256)).toBe(true);
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
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([3000, 500]);
  } finally { timeout.mockRestore(); }
});
