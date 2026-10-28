import { generateKeyPairSync } from "node:crypto";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { GithubBackendConfig } from "../config.js";
import { CloudGithubConnections } from "./github-connections.js";
import type {
  CloudGithubConnectionStore,
  CloudGithubCredentialSnapshot,
} from "./github-connections-store.js";
import { createSelectedCloudGithubTokens } from "./github-selected-tokens.js";

const scope = { organizationId: "organization", userId: "creator" };
const target = { repository: "former/project", repositoryId: "42" };
const config = {
  appId: 5,
  clientId: "fixture-client",
  apiBaseUrl: "https://api.github.com",
  variantKey: "github.com",
  privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
} as GithubBackendConfig;

function fixture(method: "github-app" | "pat" = "github-app") {
  let owner = "current";
  const assertCurrent = vi.fn(async () => {});
  const snapshot: CloudGithubCredentialSnapshot = {
    generation: "fixture-generation",
    identity: { id: "12", login: "contributor" },
    assertCurrent,
    material:
      method === "pat"
        ? { method, accessToken: "fixture-personal", expiresAt: null }
        : {
            method,
            accessToken: "fixture-human-app",
            refreshToken: "fixture-refresh",
            expiresAt: Date.now() + 3_600_000,
            refreshExpiresAt: Date.now() + 86_400_000,
          },
  };
  const issued: Record<string, unknown>[] = [],
    revoked: string[] = [];
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/user")
        return Response.json({ id: 12, login: "contributor" });
      if (path === "/repositories/42")
        return Response.json({
          id: 42,
          name: "project",
          owner: { login: owner },
          default_branch: "main",
          private: true,
          archived: false,
          permissions: { push: true },
        });
      if (path === "/repos/current/project")
        return Response.json({ id: 42, full_name: `${owner}/project` });
      if (path.endsWith("/branches")) return Response.json([]);
      if (path === "/user/installations")
        return Response.json({
          installations: [
            { id: 7, app_id: 5, account: { login: owner }, suspended_at: null },
          ],
        });
      if (path.endsWith("/access_tokens")) {
        const body = JSON.parse(String(init?.body));
        issued.push(body);
        return Response.json(
          {
            token: `fixture-installation-${issued.length}`,
            permissions: body.permissions,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          { status: 201 },
        );
      }
      if (path === "/installation/token") {
        revoked.push(new Headers(init?.headers).get("authorization")!);
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/collaborators/contributor/permission"))
        return Response.json({
          permission: "write",
          user: { id: 12, login: "contributor" },
        });
      throw new Error(`Unexpected fixture request ${path}`);
    },
  );
  const pool = { query: vi.fn() } as unknown as pg.Pool;
  const connections = new CloudGithubConnections(
    {
      credential: async () => snapshot,
    } as unknown as CloudGithubConnectionStore,
    config,
    fetcher,
  );
  return {
    token: createSelectedCloudGithubTokens(pool, connections, fetcher),
    issued,
    revoked,
    fetcher,
    assertCurrent,
    snapshot,
    move: () => {
      owner = "successor";
    },
  };
}

describe("cloud Git and gh actors", () => {
  it("narrows App Git to the pinned repository while gh keeps the selected human", async () => {
    const f = fixture();
    expect(await f.token(scope, target, "user", "git")).toMatchObject({
      token: "fixture-installation-2",
    });
    expect(f.issued).toEqual([
      { repository_ids: [42], permissions: { metadata: "read" } },
      {
        repository_ids: [42],
        permissions: {
          metadata: "read",
          contents: "write",
          pull_requests: "write",
        },
      },
    ]);
    expect(await f.token(scope, target, "user", "gh")).toMatchObject({
      token: "fixture-human-app",
    });
    expect(f.issued).toHaveLength(2);
  });
  it.each(["git", "gh"] as const)(
    "delivers the selected PAT for %s without inventing reduced GitHub scope",
    async (purpose) => {
      const f = fixture("pat"),
        before = Date.now();
      const result = await f.token(scope, target, "user", purpose);
      expect(result.token).toBe("fixture-personal");
      expect(result.expiresAt).toBeGreaterThanOrEqual(before);
      expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
      expect(f.issued).toEqual([]);
    },
  );
  it("revokes a minted token if the repository moves again during mint cleanup", async () => {
    const f = fixture(),
      original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (new URL(String(input)).pathname === "/installation/token") f.move();
      return response;
    });
    await expect(f.token(scope, target)).rejects.toMatchObject({
      code: "github_cloud_access_denied",
    });
    expect(f.revoked).toContain("Bearer fixture-installation-2");
  });
  it("rejects App delivery after the selected connection is disconnected", async () => {
    const f = fixture(),
      original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (new URL(String(input)).pathname === "/installation/token")
        f.assertCurrent.mockRejectedValue(new Error("disconnected"));
      return response;
    });
    await expect(f.token(scope, target)).rejects.toThrow("disconnected");
    expect(f.revoked).toContain("Bearer fixture-installation-2");
  });
  it("requires the installation to remain visible to the exact human after mint cleanup", async () => {
    const f = fixture(),
      original = f.fetcher.getMockImplementation()!;
    let removed = false;
    f.fetcher.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (removed && path === "/user/installations")
        return Response.json({ installations: [] });
      const result = await original(input, init);
      if (path === "/installation/token") removed = true;
      return result;
    });
    await expect(f.token(scope, target)).rejects.toMatchObject({
      code: "github_app_access_required",
    });
    expect(f.revoked).toContain("Bearer fixture-installation-2");
  });
  it("rechecks the full workspace source scope before releasing a newly minted credential", async () => {
    const f = fixture();
    await expect(
      f.token(scope, target, "read", "git", async () => {
        throw new Error("another source was revoked");
      }),
    ).rejects.toThrow("another source was revoked");
    expect(f.revoked).toContain("Bearer fixture-installation-2");
  });
});
