import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CloudGithubHttp,
  resolveCloudGithubRepository,
} from "./github-http.js";

const row = {
  id: 42,
  name: "renamed",
  owner: { login: "current" },
  default_branch: "main",
  private: true,
  archived: false,
  permissions: { push: true },
};

it("conditionally revalidates an exact scoped response across request instances", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ number: 7 }, { headers: { etag: '"revision-1"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  const assertCurrent = vi.fn(async () => {});
  const options = { apiBaseUrl: "https://api.github.com", token: "synthetic-conditional", cacheScope: "workspace-a:checkout-1:connection-1",
    fetch: fetcher, assertCurrent };
  await expect(new CloudGithubHttp(options).json("/repositories/42/pulls/7", z.object({ number: z.number() }))).resolves.toEqual({ number: 7 });
  await expect(new CloudGithubHttp(options).json("/repositories/42/pulls/7", z.object({ number: z.number() }))).resolves.toEqual({ number: 7 });
  expect(new Headers(fetcher.mock.calls[1]![1]!.headers).get("if-none-match")).toBe('"revision-1"');
  expect(assertCurrent).toHaveBeenCalledTimes(4);
});

it("cannot reuse conditional bodies across owners or credentials", async () => {
  const options = { apiBaseUrl: "https://api.github.com", token: "synthetic-owner-one", cacheScope: "owner-one:workspace-one",
    assertCurrent: async () => {}, fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ number: 8 }, { headers: { etag: '"private"' } })) };
  await new CloudGithubHttp(options).json("/repositories/42/pulls/8", z.unknown());
  for (const replacement of [{ cacheScope: "owner-two:workspace-one" }, { token: "synthetic-owner-two" }]) {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 304 }));
    await expect(new CloudGithubHttp({ ...options, ...replacement, fetch: fetcher }).json("/repositories/42/pulls/8", z.unknown()))
      .rejects.toMatchObject({ code: "github_unavailable" });
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).has("if-none-match")).toBe(false);
  }
});

it("fences a 304 response after access is revoked while GitHub is reading", async () => {
  const assertCurrent = vi.fn(async () => {});
  const options = { apiBaseUrl: "https://api.github.com", token: "synthetic-revoked-conditional", cacheScope: "owner:workspace:revoked",
    assertCurrent, fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ number: 9 }, { headers: { etag: '"private"' } })) };
  await new CloudGithubHttp(options).json("/repositories/42/pulls/9", z.unknown());
  const failure = Object.assign(new Error("Revoked"), { code: "github_authorization_changed" });
  options.fetch.mockImplementation(async () => {
    assertCurrent.mockRejectedValueOnce(failure);
    return new Response(null, { status: 304 });
  });
  await expect(new CloudGithubHttp(options).json("/repositories/42/pulls/9", z.unknown())).rejects.toBe(failure);
});

it.each([
  { name: "entry count", count: 129, size: 1 },
  { name: "retained bytes", count: 9, size: 1024 * 1024 },
])("bounds the conditional cache by $name", async ({ name, count, size }) => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({ text: "x".repeat(size) }, { headers: { etag: '"bounded"' } }));
  const http = new CloudGithubHttp({ apiBaseUrl: "https://api.github.com", token: "synthetic-bounded", cacheScope: name,
    fetch: fetcher, assertCurrent: async () => {} });
  for (let i = 0; i < count; i++) await http.json(`/bounded/${i}`, z.unknown());
  await http.json("/bounded/0", z.unknown());
  expect(new Headers(fetcher.mock.lastCall![1]!.headers).has("if-none-match")).toBe(false);
  await http.json(`/bounded/${count - 1}`, z.unknown());
  expect(new Headers(fetcher.mock.lastCall![1]!.headers).get("if-none-match")).toBe('"bounded"');
});

it("expires a conditional body before contacting GitHub", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ number: 10 }, { headers: { etag: '"expired"' } }));
    const http = new CloudGithubHttp({ apiBaseUrl: "https://api.github.com", token: "synthetic-expiry", cacheScope: "expiry",
      fetch: fetcher, assertCurrent: async () => {} });
    await http.json("/repositories/42/pulls/10", z.unknown());
    now.mockReturnValue(1_000_000 + 15 * 60_000);
    await http.json("/repositories/42/pulls/10", z.unknown());
    expect(new Headers(fetcher.mock.lastCall![1]!.headers).has("if-none-match")).toBe(false);
  } finally { now.mockRestore(); }
});

it.each([
  { headers: { "retry-after": "120" }, body: { message: "Please retry later." } },
  { headers: {}, body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." } },
  { headers: {}, body: { message: "You have triggered an abuse detection mechanism. Please wait a few minutes before you try again." } },
])("classifies GitHub secondary throttling as retryable without disclosing its body", async ({ headers, body }) => {
  const http = new CloudGithubHttp({
    apiBaseUrl: "https://api.github.com", token: "synthetic-token", assertCurrent: async () => {},
    fetch: vi.fn(async () => Response.json({ ...body, private: "private-provider-canary" }, { status: 403, headers })),
  });
  const error = await http.json("/user", z.unknown()).catch(error => error);
  expect(error).toMatchObject({ status: 429, code: "github_rate_limited" });
  expect(String(error)).not.toContain("private-provider-canary");
});
it("follows GitHub's repository redirect without forgetting an immutable ID", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: "https://api.github.com/repositories/42" },
      }),
    )
    .mockResolvedValueOnce(Response.json(row));
  const http = new CloudGithubHttp({
    apiBaseUrl: "https://api.github.com",
    token: "synthetic-token",
    fetch: fetcher,
    assertCurrent: async () => {},
  });
  await expect(
    resolveCloudGithubRepository(http, { repository: "former/project" }),
  ).resolves.toMatchObject({
    repositoryId: "42",
    repository: "current/renamed",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([
  "https://attacker.example/repositories/42",
  "https://api.github.com/user",
  "https://identity@api.github.com/repositories/42",
  "/repositories/42?leak=1",
])("refuses a repository redirect to %s", async (location) => {
  const fetcher = vi.fn(
    async () => new Response(null, { status: 301, headers: { location } }),
  );
  const http = new CloudGithubHttp({
    apiBaseUrl: "https://api.github.com",
    token: "synthetic-token",
    fetch: fetcher,
    assertCurrent: async () => {},
  });
  await expect(
    resolveCloudGithubRepository(http, { repository: "former/project" }),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("never binds a pinned checkout to a reused old name", async () => {
  const fetcher = vi.fn(async (_url: string | URL | Request) =>
    Response.json({ ...row, id: 99 }),
  );
  const http = new CloudGithubHttp({
    apiBaseUrl: "https://api.github.com",
    token: "synthetic-token",
    fetch: fetcher,
    assertCurrent: async () => {},
  });
  await expect(
    resolveCloudGithubRepository(http, {
      repository: "former/project",
      repositoryId: "42",
    }),
  ).rejects.toMatchObject({ code: "github_repository_changed" });
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    "https://api.github.com/repositories/42",
  );
});
