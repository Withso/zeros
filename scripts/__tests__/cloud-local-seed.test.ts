import { expect, it, vi } from "vitest";
import { seedLocalEnvironment } from "../dev-environment/local-seed.mjs";
import { gate0LocalIdentity } from "../../apps/control-plane/src/cloud/gate0-cli.js";

function fixture() {
  const owner = "a".repeat(24), runId = "22222222-2222-4222-8222-222222222222";
  const workspace = { state: { status: "active", owner, instanceId: "11111111-1111-4111-8111-111111111111",
    launcher: { runId }, keys: { settings: "b".repeat(64), agent: "c".repeat(64) } } };
  const profile = { workos: { webClientId: "client_local", apiKey: "workos-fixture-value" },
    github: { appId: 456, clientId: "client_github", privateKeyBase64: "fixture" },
    fixture: { workosUserId: "user_localfixture", workosOrganizationId: "org_localfixture",
      expectedEmail: "local-fixture@example.test", expectedOrganizationSlug: "local-fixture", computeAllowance: "pro-monthly" } };
  const ports = { api: 23456 };
  const health = { ok: true, development: { owner, runId } };
  const session = { accessToken: vi.fn(async () => "fixture-access"), close: vi.fn(async () => {}) };
  const signIn = vi.fn(async () => session), save = vi.fn(), database = vi.fn(async () => ({ seeded: false, needsSignIn: true }));
  const request = vi.fn(async (input: string, init: { method?: string } = {}) => {
    expect(init.method ?? "GET").toBe("GET");
    const url = new URL(input);
    if (url.origin === "http://127.0.0.1:23456") {
      if (url.pathname === "/healthz") return Response.json(health);
      if (url.pathname === "/v1/me") return Response.json({ user: { id: "fixture" } });
    }
    if (url.hostname === "api.workos.com") {
      if (url.pathname === "/user_management/users/user_localfixture") return Response.json({ id: "user_localfixture", email: "local-fixture@example.test", email_verified: true });
      if (url.pathname === "/organizations/org_localfixture") return Response.json({ id: "org_localfixture", external_id: "33333333-3333-4333-8333-333333333333", name: "Local fixture", metadata: { purpose: "zeros-development" } });
      if (url.pathname === "/user_management/organization_memberships") return Response.json({ data: [{ id: "om_localfixture", user_id: "user_localfixture", organization_id: "org_localfixture", status: "active", role: { slug: "owner" }, updated_at: new Date().toISOString() }], list_metadata: { after: null } });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/repos/example/project/installation") return Response.json({
      id: 123, app_id: 456, account: { login: "example", type: "Organization" }, target_type: "Organization", repository_selection: "selected", created_at: new Date().toISOString(),
    });
    throw new Error("Unexpected fixture request");
  });
  const options = { fetch: request, database, save,
    agentEnv: { ZEROS_DEV_GITHUB_INSTALLATION_ID: "123", ZEROS_DEV_REPOSITORY: "example/project", OPENAI_API_KEY: "fixture-codex-value" },
    module: async (name: string) => {
      if (name === "cloud/gate0-cli.js") return { gate0LocalIdentity, gate0SignIn: signIn };
      if (name === "github-app-jwt.js") return { createGithubAppJwt: () => "fixture-app-jwt" };
      throw new Error("Unexpected fixture module");
    } };
  return { workspace, profile, ports, health, session, signIn, options, request, database };
}

it("checks loopback ownership before forwarding fixture material and permits interactive sign-in", async () => {
  const f = fixture();
  expect(await seedLocalEnvironment(f.workspace, f.profile, f.ports, "/unused", f.options)).toEqual({ seeded: false, needsSignIn: true });
  expect(f.signIn).not.toHaveBeenCalled();
  expect(f.request.mock.calls[0]?.[0]).toBe("http://127.0.0.1:23456/healthz");
  expect(f.database).toHaveBeenCalledWith(f.workspace, f.ports, "/unused", "seed", expect.objectContaining({
    credentials: [{ provider: "codex", material: { kind: "codex-api-key", apiKey: "fixture-codex-value" } }],
    githubProof: expect.objectContaining({ installationId: 123, repository: "example/project" }),
  }));
});

it("never forwards credentials to a different local launch", async () => {
  const f = fixture();
  f.health.development.runId = "44444444-4444-4444-8444-444444444444";
  await expect(seedLocalEnvironment(f.workspace, f.profile, f.ports, "/unused", f.options)).rejects.toThrow();
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.database).not.toHaveBeenCalled();
  expect(f.signIn).not.toHaveBeenCalled();
});

it("bootstraps through the authenticated API and closes only its own temporary session on failure", async () => {
  const f = fixture();
  f.database.mockRejectedValueOnce(new Error("fixture database unavailable"));
  await expect(seedLocalEnvironment(f.workspace, f.profile, f.ports, "/unused", {
    ...f.options, agentEnv: { ...f.options.agentEnv, ZEROS_DEV_PASSWORD: "test-password" },
  })).rejects.toThrow(/database unavailable/);
  expect(f.signIn).toHaveBeenCalledOnce();
  // A member of several WorkOS organizations finishes sign-in inside the fixture's.
  expect(f.signIn).toHaveBeenCalledWith(expect.objectContaining({ subject: "user_localfixture", organizationId: "org_localfixture" }), f.request);
  expect(f.request.mock.calls.map(([url]) => url)).toContain("http://127.0.0.1:23456/v1/me");
  expect(f.session.close).toHaveBeenCalledOnce();
});
