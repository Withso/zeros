import { describe, expect, it, vi } from "vitest";
import type { GithubBackendConfig } from "../config.js";
import { GithubCloudUserAccess } from "./github-user-access.js";
const config = { apiBaseUrl: "https://api.github.com" } as GithubBackendConfig;
const installation = {
  installationId: 123,
  accountLogin: "sample-org",
  accountType: "Organization" as const,
  suspendedAt: null,
};
const repo = {
  id: 345,
  name: "sample",
  owner: { login: "sample-org" },
  default_branch: "main",
  private: true,
  archived: false,
  disabled: false,
};
describe("GitHub cloud repository permissions", () => {
  it("requires explicit user write permission while preserving ordinary read access", async () => {
    const fetch = vi.fn(async () => Response.json(repo));
    const api = new GithubCloudUserAccess(config, fetch);
    await expect(api.source("test-token", installation, "sample-org", "sample")).resolves.toMatchObject({ id: "345" });
    await expect(api.source("test-token", installation, "sample-org", "sample", true)).rejects.toMatchObject({ code: "github_cloud_write_denied" });
    fetch.mockImplementation(async () => Response.json({ ...repo, permissions: { push: false, pull: true } }));
    await expect(api.source("test-token", installation, "sample-org", "sample", true)).rejects.toMatchObject({ code: "github_cloud_write_denied" });
    fetch.mockImplementation(async () => Response.json({ ...repo, permissions: { push: true } }));
    await expect(api.source("test-token", installation, "sample-org", "sample", true)).resolves.toMatchObject({ id: "345" });
  });
  it("requires active membership, including private organization membership", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            state: "active",
            organization: { login: "sample-org" },
          }),
        ),
      );
    await new GithubCloudUserAccess(config, fetch).assertAccount(
      "synthetic-user-token",
      "sample-member",
      installation,
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/user/memberships/orgs/sample-org",
      expect.objectContaining({ redirect: "error" }),
    );
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          state: "pending",
          organization: { login: "sample-org" },
        }),
      ),
    );
    await expect(
      new GithubCloudUserAccess(config, fetch).assertAccount(
        "synthetic-user-token",
        "sample-member",
        installation,
      ),
    ).rejects.toMatchObject({ code: "github_cloud_membership_required" });
  });
  it("never connects a different personal GitHub account just because a repository is shared", async () => {
    const fetch = vi.fn(),
      api = new GithubCloudUserAccess(config, fetch);
    await expect(
      api.assertAccount("synthetic-user-token", "member", {
        ...installation,
        accountType: "User",
        accountLogin: "someone-else",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the user's installation repository endpoint, filters disabled sources, and projects metadata only", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            repositories: [
              repo,
              { ...repo, id: 346, archived: true },
              { ...repo, id: 347, owner: { login: "unrelated" } },
            ],
            accessToken: "never-public",
          }),
        ),
      );
    const result = await new GithubCloudUserAccess(config, fetch).repositories(
      "synthetic-user-token",
      installation,
      1,
    );
    expect(result).toEqual({
      repositories: [
        {
          id: "345",
          owner: "sample-org",
          name: "sample",
          defaultBranch: "main",
          private: true,
        },
      ],
      nextPage: null,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/user/installations/123/repositories?per_page=100&page=1",
      expect.anything(),
    );
  });
  it("fails closed on denied membership and suppresses upstream error bodies", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("private-upstream-details", { status: 403 }),
      );
    await expect(
      new GithubCloudUserAccess(config, fetch).assertAccount(
        "synthetic-user-token",
        "member",
        installation,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

