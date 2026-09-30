import { describe, expect, it, vi } from "vitest";
import { githubPorts } from "./github.js";
const config = {
  appId: "42",
  clientId: "client_dev",
  clientSecret: "synthetic-client-secret",
};
const material = {
  kind: "github-app" as const,
  accessToken: "synthetic-access-token",
  refreshToken: "synthetic-refresh-token",
  expiresAt: 1900000000,
  refreshExpiresAt: 1910000000,
  accountId: "1234",
  appId: "42",
  clientId: "client_dev",
};
const scope = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  action: "github:read" as const,
  repository: "example/repo",
  installationId: 99,
};
function fixture(
  overrides: {
    clientId?: string;
    account?: number;
    push?: boolean;
    appId?: number;
    repos?: string[];
  } = {},
) {
  return vi.fn(async (url: string) => {
    if (url.includes("/applications/"))
      return Response.json({
        app: { client_id: overrides.clientId ?? "client_dev" },
        user: { id: overrides.account ?? 1234 },
      });
    if (url.endsWith("/user"))
      return Response.json({ id: overrides.account ?? 1234 });
    if (url.includes("/user/installations/99/repositories"))
      return Response.json({
        repositories: (overrides.repos ?? ["example/repo"]).map(
          (full_name) => ({ full_name }),
        ),
      });
    if (url.includes("/user/installations"))
      return Response.json({
        installations: [
          { id: 99, app_id: overrides.appId ?? 42, suspended_at: null },
        ],
      });
    if (url.includes("/repos/"))
      return Response.json({
        full_name: "example/repo",
        permissions: { pull: true, push: overrides.push ?? false },
      });
    throw new Error("unexpected synthetic request");
  });
}
describe("broker GitHub refresh and current permission intersection", () => {
  it("checks the actual token app/client, not caller-supplied metadata", async () => {
    const fetcher = fixture({ clientId: "client_other" });
    await expect(
      githubPorts(config, fetcher).identity(material),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("checks user, installation app and exact repository on every request", async () => {
    await githubPorts(config, fixture()).access(material, scope);
    for (const change of [
      { account: 9999 },
      { appId: 9999 },
      { repos: ["example/other"] },
    ])
      await expect(
        githubPorts(config, fixture(change)).access(material, scope),
      ).rejects.toMatchObject({ status: 403 });
    await expect(
      githubPorts(config, fixture()).access(material, {
        ...scope,
        action: "github:write",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("commits dispatch before calling token rotation and never retries provider errors", async () => {
    let dispatched = false;
    const fetcher = vi.fn(async () => {
      expect(dispatched).toBe(true);
      throw new Error("synthetic-provider-secret");
    });
    await expect(
      githubPorts(config, fetcher).renew(material, async () => {
        dispatched = true;
      }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
