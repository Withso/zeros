import { afterEach, expect, it, vi } from "vitest";
import { HttpError } from "./authz.js";
import { GithubTemporaryError, githubRateLimit, githubRetryAfter, isGithubAccessRevoked, isGithubTemporary } from "./github-availability.js";

afterEach(() => { vi.useRealTimers(); });

it("honors the longest documented retry delay, with a minimum and a finite maximum", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  expect(githubRetryAfter(new Response(null, { headers: { "retry-after": "120" } }), now)).toBe(120_000);
  expect(githubRetryAfter(new Response(null, { headers: { "retry-after": "Thu, 01 Jan 2026 00:03:00 GMT" } }), now)).toBe(180_000);
  expect(githubRetryAfter(new Response(null, { headers: { "retry-after": "120", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 300) } }), now)).toBe(300_000);
  expect(githubRetryAfter(new Response(null, { headers: { "retry-after": "999999999" } }), now)).toBe(86_400_000);
  for (const value of ["-10", "nonsense", "0"]) expect(githubRetryAfter(new Response(null, { headers: { "retry-after": value } }), now)).toBe(60_000);
});

it("distinguishes explicit SSO/permission denials from primary and secondary rate limits", async () => {
  const limited = await githubRateLimit(Response.json({ message: "API rate limit exceeded" }, { status: 403 }));
  expect(limited).toBeInstanceOf(GithubTemporaryError);
  expect(isGithubTemporary(limited)).toBe(true);
  expect(isGithubAccessRevoked(limited)).toBe(false);
  expect(await githubRateLimit(Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 }))).toBeNull();
  expect(await githubRateLimit(new Response(null, { status: 403, headers: { "x-github-sso": "required; url=https://github.com/sso", "retry-after": "120" } }))).toBeNull();
  expect(isGithubTemporary(new HttpError(403, "github_cloud_access_denied", "denied"))).toBe(false);
  expect(isGithubTemporary(new HttpError(503, "unknown_error", "unknown"))).toBe(false);
});

it("bounds an oversized error envelope and never reflects its private content", async () => {
  const error = await githubRateLimit(new Response("private-canary".repeat(2000), { status: 403 })).catch(error => error);
  expect(error).toMatchObject({ code: "github_unavailable", status: 503 });
  expect(String(error)).not.toContain("private-canary");
});

it("does not wait forever for an error body or its cancellation", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(async () => { await new Promise(() => {}); });
  const response = new Response(new ReadableStream({ cancel }), { status: 403 });
  const pending = githubRateLimit(response);
  const checked = expect(pending).rejects.toMatchObject({ code: "github_unavailable" });
  await vi.advanceTimersByTimeAsync(2001);
  await checked;
  expect(cancel).toHaveBeenCalledOnce();
});

it("returns a header-confirmed rate limit without awaiting body cancellation", async () => {
  const response = new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status: 403, headers: { "retry-after": "120" } });
  let result: unknown;
  void githubRateLimit(response).then(value => { result = value; });
  await vi.waitFor(() => expect(result).toMatchObject({ code: "github_rate_limited", retryAfterMs: 120_000 }));
});
