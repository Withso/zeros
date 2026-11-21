import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { GithubBackendConfig } from "../config.js";
import { organizationCloneToken } from "./organization-github.js";
import type { CloudGithubInstallation } from "./repository-levels.js";

const config = { appId: 9, apiBaseUrl: "https://api.github.test",
  privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString() } as GithubBackendConfig;
const target = { repository: "withso/zeros", repositoryId: "42" };
const org = "11111111-1111-4111-8111-111111111111";

function fixture(connection: Partial<CloudGithubInstallation> | null, github: { installation?: number | null; suspended?: boolean; mint?: number } = {}) {
  const levels = {
    organizationInstallation: vi.fn(async () => connection ? { id: "c1", installationId: 501, accountLogin: "withso", level: "organization" as const,
      state: "active" as const, mine: false, ...connection } : null),
    bindInstallation: vi.fn(async () => {}),
    installationState: vi.fn(async () => 1),
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/repos/withso/zeros/installation")
      return github.installation === null ? new Response("{}", { status: 404 })
        : Response.json({ id: github.installation ?? 501, account: { login: "withso" }, suspended_at: github.suspended ? "2026-11-01T00:00:00Z" : null });
    if (path.endsWith("/access_tokens")) {
      if (github.mint) return new Response("{}", { status: github.mint });
      const body = JSON.parse(String(init?.body));
      return Response.json({ token: "ghs_fixture", expires_at: new Date(Date.now() + 60 * 60_000).toISOString(), permissions: body.permissions });
    }
    return new Response("{}", { status: 500 });
  });
  return { levels, fetchImpl, token: organizationCloneToken({ levels, config, fetch: fetchImpl as unknown as typeof fetch }) };
}

describe("organization connection clone tokens", () => {
  it("mints an installation token for exactly one repository, read only, with the App's own key", async () => {
    const f = fixture({});
    expect(await f.token(org, target)).toBe("ghs_fixture");
    const mint = f.fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/app/installations/501/access_tokens"))!;
    expect(JSON.parse(String(mint[1]?.body))).toEqual({ repository_ids: [42], permissions: { metadata: "read", contents: "read" } });
    expect(new Headers(mint[1]?.headers).get("authorization")).toMatch(/^Bearer eyJ/);
  });

  it("binds a migrated connection to the installation GitHub reports for its own account", async () => {
    const f = fixture({ installationId: null });
    expect(await f.token(org, target)).toBe("ghs_fixture");
    expect(f.levels.bindInstallation).toHaveBeenCalledWith(org, "withso", 501);
  });

  it.each([
    ["no organization connection", null, {}, "organization_connection_required"],
    ["the App uninstalled since", {}, { installation: null }, "github_installation_required"],
    ["the App suspended since", {}, { suspended: true }, "github_installation_suspended"],
    ["another installation now holds the repository", {}, { installation: 777 }, "organization_connection_required"],
    ["the repository left the installation's selection", {}, { mint: 403 }, "github_app_access_required"],
  ] as const)("refuses with one clear reason when %s", async (_case, connection, github, code) => {
    const f = fixture(connection, github);
    await expect(f.token(org, target)).rejects.toMatchObject({ code });
  });

  it("records the edge state GitHub reported on the connection", async () => {
    const suspended = fixture({}, { suspended: true });
    await suspended.token(org, target).catch(() => {});
    expect(suspended.levels.installationState).toHaveBeenCalledWith(501, "suspended");
    const removed = fixture({}, { installation: null });
    await removed.token(org, target).catch(() => {});
    expect(removed.levels.installationState).toHaveBeenCalledWith(501, "uninstalled");
    const healthy = fixture({ state: "active" });
    await healthy.token(org, target);
    expect(healthy.levels.installationState).not.toHaveBeenCalled();
    // Reinstalled or unsuspended in GitHub: the next use clears the recorded state.
    const restored = fixture({ state: "suspended" });
    expect(await restored.token(org, target)).toBe("ghs_fixture");
    expect(restored.levels.installationState).toHaveBeenCalledWith(501, "active");
  });
});
