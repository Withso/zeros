import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Gate0Failure } from "./gate0.js";
import { loadAlphaRuntimeCanary, runAlphaRuntimeCanary } from "./runtime-canary-gate0.js";

function fixture() {
  const creatorUserId = randomUUID(), organizationId = randomUUID();
  const claims = { version: 1, iss: "zeros-runtime-release", aud: "zeros-cloud-runtime-canary", channel: "alpha", jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900, runId: "123", runAttempt: 1,
    runtimeSha256: "a".repeat(64), sourceSha: "b".repeat(40), creatorUserId, organizationId, repositoryId: "42", createKey: randomUUID() };
  const env = { CLOUD_RUNTIME_CANARY_GRANT: "synthetic-canary-grant", CLOUD_RUNTIME_CANARY_CLAIMS: JSON.stringify(claims),
    CLOUD_RUNTIME_CANARY_REPOSITORY: "fixture/repo", CLOUD_RUNTIME_RELEASE_CP_SHA: "c".repeat(40), CLOUD_RUNTIME_RELEASE_PRIOR_SHA256: "d".repeat(64),
    WORKOS_CLIENT_ID: "client_fixture", WORKOS_API_KEY: "synthetic-workos-api-key", CLOUD_RUNTIME_FIXTURE_EMAIL: "fixture@example.test",
    CLOUD_RUNTIME_FIXTURE_PASSWORD: "synthetic-fixture-password", CLOUD_RUNTIME_FIXTURE_WORKOS_USER_ID: "user_fixture" };
  const identity: Record<string, unknown> = { version: 1, ready: true, channel: "alpha", sourceSha: env.CLOUD_RUNTIME_RELEASE_CP_SHA,
    maintenance: false, cloud: { enabled: true, ready: true, state: "healthy" }, migrations: { state: "current" },
    runtimeCanaryAdmission: 1, worker: { sha256: env.CLOUD_RUNTIME_RELEASE_PRIOR_SHA256 } };
  const user: Record<string, unknown> = { id: creatorUserId, staffRole: null };
  const organizations = [{ id: organizationId, isPersonal: false }];
  const connections = ["codex", "claude", "cursor"].map(provider => ({ provider, connected: true }));
  const events: string[] = [], logs: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    expect(target.origin).toBe("https://api-alpha.zeros.build");
    expect(init?.redirect).toBe("error");
    events.push(target.pathname);
    if (target.pathname === "/v1/release-identity") {
      expect(init?.headers ?? {}).not.toHaveProperty("authorization");
      return Response.json(identity);
    }
    expect(init?.headers).toMatchObject({ authorization: "Bearer synthetic-fixture-access" });
    if (target.pathname === "/v1/me") return Response.json({ user, organizations });
    return Response.json({ connections });
  });
  const close = vi.fn(async () => { events.push("sign_out"); });
  const signIn = vi.fn(async () => { events.push("sign_in"); return { accessToken: async () => "synthetic-fixture-access", close }; });
  const gate0 = vi.fn(async () => { events.push("gate0_deleted"); return { workspaceId: randomUUID(), agents: ["codex", "claude", "cursor"] as const, deleted: true }; });
  const run = () => runAlphaRuntimeCanary(loadAlphaRuntimeCanary(env), { fetch: fetchImpl, signIn, gate0, log: message => logs.push(message) });
  return { env, claims, identity, user, organizations, connections, events, logs, fetchImpl, signIn, close, gate0, run };
}

describe("Alpha runtime canary gate0", () => {
  it("checks exact live identity before sign-in and after cleanup, revokes its own session, and returns only allowlisted proof", async () => {
    const f = fixture(), proof = await f.run();
    expect(proof).toMatchObject({ version: 1, channel: "alpha", cpSourceSha: f.env.CLOUD_RUNTIME_RELEASE_CP_SHA,
      previousRuntimeSha256: f.env.CLOUD_RUNTIME_RELEASE_PRIOR_SHA256, runtimeSha256: f.claims.runtimeSha256,
      sourceSha: f.claims.sourceSha, runId: "123", runAttempt: 1, grantId: f.claims.jti, deleted: true });
    expect(f.events).toEqual(["/v1/release-identity", "sign_in", "/v1/me",
      `/v1/organizations/${f.claims.organizationId}/agent-connections`, "gate0_deleted", "/v1/release-identity", "sign_out"]);
    expect(f.gate0).toHaveBeenCalledWith(expect.objectContaining({ apiOrigin: "https://api-alpha.zeros.build", keep: false,
      runtimeSha: f.claims.runtimeSha256, agents: ["codex", "claude", "cursor"], canary: { token: f.env.CLOUD_RUNTIME_CANARY_GRANT, claims: f.claims } }));
    for (const secret of [f.env.CLOUD_RUNTIME_CANARY_GRANT, f.env.CLOUD_RUNTIME_FIXTURE_PASSWORD, f.env.WORKOS_API_KEY, "synthetic-fixture-access"])
      expect(JSON.stringify(proof) + f.logs.join("\n")).not.toContain(secret);
  });

  it.each([{ runtimeCanaryAdmission: undefined }, { channel: "beta" }, { ready: false }, { sourceSha: "e".repeat(40) },
    { worker: { sha256: "e".repeat(64) } }, { cloud: { enabled: false, ready: true, state: "disabled" } }])(
    "refuses an unsupported or changed deployment before creating a fixture session: %j", async patch => {
      const f = fixture(); Object.assign(f.identity, patch);
      await expect(f.run()).rejects.toThrow("alpha_release_identity");
      expect(f.signIn).not.toHaveBeenCalled(); expect(f.gate0).not.toHaveBeenCalled();
    });

  it.each(["creator", "organization", "staff", "provider"])("refuses a mismatched %s and signs out without a VM start", async change => {
    const f = fixture();
    if (change === "creator") f.user.id = randomUUID();
    if (change === "organization") f.organizations[0]!.id = randomUUID();
    if (change === "staff") f.user.staffRole = "admin";
    if (change === "provider") f.connections[2]!.connected = false;
    await expect(f.run()).rejects.toBeInstanceOf(Gate0Failure);
    expect(f.gate0).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
  });

  it("refuses changed live CP/pin authority even after the canary was deleted", async () => {
    const f = fixture(); f.gate0.mockImplementationOnce(async () => {
      f.identity.sourceSha = "e".repeat(40);
      return { workspaceId: randomUUID(), agents: ["codex", "claude", "cursor"], deleted: true };
    });
    await expect(f.run()).rejects.toThrow("alpha_release_identity"); expect(f.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])("refuses incomplete cleanup or failed sign-out (sign-out failure=%s)", async signOut => {
    const f = fixture();
    if (signOut) f.close.mockRejectedValueOnce(new Error("synthetic-private-provider-response"));
    else f.gate0.mockResolvedValueOnce({ workspaceId: randomUUID(), agents: ["codex", "claude", "cursor"], deleted: false });
    await expect(f.run()).rejects.toBeInstanceOf(Gate0Failure);
    expect(f.close).toHaveBeenCalledOnce(); expect(f.logs.join("\n")).not.toContain("synthetic-private-provider-response");
  });

  it("suppresses unstructured external failures and still revokes the issued session", async () => {
    const f = fixture(); f.gate0.mockRejectedValueOnce(new Error("synthetic-private-provider-response"));
    await expect(f.run()).rejects.toThrow("alpha_canary"); expect(f.close).toHaveBeenCalledOnce();
  });

  it.each(["CLOUD_RUNTIME_CANARY_GRANT", "CLOUD_RUNTIME_CANARY_CLAIMS", "CLOUD_RUNTIME_RELEASE_CP_SHA", "CLOUD_RUNTIME_FIXTURE_PASSWORD"] as const)(
    "refuses incomplete private configuration without reflecting %s", key => {
      const f = fixture();
      expect(() => loadAlphaRuntimeCanary({ ...f.env, [key]: "" })).toThrow("alpha_canary_configuration");
    });
});
