import { afterEach, describe, expect, it, vi } from "vitest";
import { getPr, listRepositoryBranches, setOctokitFactoryForTesting, setTokenStore } from "../github";
import { githubReadTransport, runWithGithubReadTransport } from "../github-read-context";
import { runWithGithubWriteCredential } from "../github-write-context";

afterEach(() => setOctokitFactoryForTesting(null));
describe("cloud GitHub reads without a VM token", () => {
  it("rejects a response when its actor disconnects during the read", async () => {
    let authorized = true;
    const read = vi.fn(async () => { authorized = false; return Response.json({ private: "data" }); });
    await expect(runWithGithubReadTransport(read, () => authorized, () => githubReadTransport()!("https://api.github.com/repos/org/repo")))
      .rejects.toThrow("GitHub read authorization");
  });
  it("reads PRs and branch metadata with the request's actor transport", async () => {
    const get = vi.fn(async () => null);
    setTokenStore({ get, set: vi.fn(), clear: vi.fn() });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/pulls/7")) return Response.json({ number: 7, state: "open", title: "Review", user: { login: "member" }, head: { ref: "topic", sha: "a".repeat(40) }, base: { ref: "main" } });
      if (path.endsWith("/branches")) return Response.json([{ name: "main" }, { name: "topic" }]);
      return Response.json({ default_branch: "main" });
    });
    await runWithGithubReadTransport(fetcher, () => true, async () => {
      expect((await getPr({ workspaceId: "unused", prNumber: 7 }, { owner: "org", repo: "repo" })).number).toBe(7);
      expect(await listRepositoryBranches({ owner: "org", repo: "repo" })).toEqual([{ name: "main", isDefault: true }, { name: "topic", isDefault: false }]);
    });
    expect(get).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(listRepositoryBranches({ owner: "org", repo: "repo" })).rejects.toThrow("Not signed in");
  });

  it("rejects retired actor authority and keeps write credentials first", async () => {
    const read = vi.fn();
    await expect(runWithGithubReadTransport(read, () => false, () => listRepositoryBranches({ owner: "org", repo: "repo" }))).rejects.toThrow("GitHub read authorization");
    const factory = vi.fn(async () => ({ repos: { get: async () => ({ data: { default_branch: "main" } }), listBranches: async () => ({ data: [] }) } }));
    setOctokitFactoryForTesting(factory as never);
    const credential = { token: "synthetic-capability", owner: "org", repository: "repo", expiresAtMs: Date.now() + 60_000, apiBaseUrl: "https://control.example.test/write", gitBaseUrl: "https://control.example.test/git/" };
    await runWithGithubReadTransport(read, () => true, () => runWithGithubWriteCredential(credential, () => true, () => listRepositoryBranches({ owner: "org", repo: "repo" })));
    expect(factory).toHaveBeenCalledWith(credential.token, credential.apiBaseUrl);
    expect(read).not.toHaveBeenCalled();
  });
});
