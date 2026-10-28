import { expect, it, vi } from "vitest";
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
