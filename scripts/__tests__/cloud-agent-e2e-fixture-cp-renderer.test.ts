import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CloudNativeCapabilitiesSchema } from "@zeros/protocol/cloud-agent-execution";
import { createFixtureControlPlane, type FixtureControlPlane } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/server";

const fixtures: FixtureControlPlane[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.close())); });
const models = { claude: ["fixture-claude-model"], codex: ["fixture-codex-model"], cursor: ["fixture-cursor-model"] };
async function setup(options: Parameters<typeof createFixtureControlPlane>[0] = {}) {
  const cp = createFixtureControlPlane({ allowedModels: models, ...options });
  fixtures.push(cp);
  const runtime = { profile: "zeros-cloud-worker-v4" as const, manifestSha256: "a".repeat(64), runtimeId: `r1-${"a".repeat(64)}`,
    baseCompatibilityId: `bc1-${"b".repeat(64)}`, installerReceiptSha256: "c".repeat(64), bootId: randomUUID(), supervisorSessionId: randomUUID() };
  cp.configureRuntime(runtime);
  const { baseUrl } = await cp.start();
  const register = () => fetch(`${baseUrl}/internal/v1/cloud-workspaces/engine/register`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cp.runtimeTokens.registrationToken}` },
    body: JSON.stringify({ ...cp.identity, actorProtocolVersion: 2, agentCustomizationVersion: 3, agentRuntime: runtime }) });
  const prepare = (bearerToken = cp.rendererAuthority().bearerToken, body: unknown = {}, workspaceId = cp.identity.workspaceId) =>
    fetch(`${baseUrl}/v1/cloud-workspaces/${workspaceId}/agent-credentials/prepare`, { method: "POST",
      headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify(body) });
  return { cp, baseUrl, prepare, register };
}

describe("fixture real-renderer prepare metadata", () => {
  it("uses a separate synthetic user authority and returns exact current compute/delegation metadata", async () => {
    const { cp, prepare, register } = await setup();
    expect(cp.rendererAuthority().userId).toBe(cp.actor.userId);
    expect(cp.rendererAuthority().bearerToken).not.toBe(cp.actorGrantToken);
    expect(cp.rendererAuthority().bearerToken).not.toBe(cp.authority().heartbeatToken);
    expect((await register()).status).toBe(200);
    const response = await prepare();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["compute", "delegations"]);
    expect(body.compute).toEqual({ fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), trust: "zeros-managed" });
    expect(body.delegations).toHaveLength(3);
    for (const provider of ["claude", "codex", "cursor"] as const) {
      const row = body.delegations.find((value: { kind: string }) => value.kind.startsWith(`${provider}-`));
      expect(row).toEqual({ id: cp.delegationId(provider), ownerUserId: cp.actor.userId, kind: `${provider}-api-key`, models: models[provider],
        allModels: false, expiresAt: expect.any(String), runtimeQualified: true, runtimeUpgradeRequired: false,
        mcpQualified: true, nativeCapabilities: expect.any(Object) });
      expect(Date.parse(row.expiresAt)).toBeGreaterThan(Date.now() + 5000);
      expect(CloudNativeCapabilitiesSchema.safeParse(row.nativeCapabilities).success).toBe(true);
    }
    expect(JSON.stringify(body)).not.toMatch(/fixture-invalid-key|apiKey|accessToken|authorization|bearerToken/);
  });

  it.each(["heartbeat", "bridge", "registration", "foreign"] as const)("refuses %s authority at the public endpoint", async kind => {
    const { cp, prepare, register } = await setup();
    await register();
    const token = kind === "heartbeat" ? cp.authority().heartbeatToken : kind === "bridge" ? cp.actorGrantToken :
      kind === "registration" ? cp.runtimeTokens.registrationToken : "fixture-foreign-user-authority";
    const response = await prepare(token);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it("keeps exact empty-body and workspace ownership refusals closed", async () => {
    const { cp, prepare, register } = await setup();
    await register();
    expect((await prepare(cp.rendererAuthority().bearerToken, { prompt: "private-fixture-sentinel" })).status).toBe(422);
    const foreign = await prepare(cp.rendererAuthority().bearerToken, {}, randomUUID());
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: { code: "cloud_agent_authority_rejected", message: expect.any(String) } });
    expect(JSON.stringify(cp.inspect())).not.toMatch(/private-fixture-sentinel|fixture-foreign-user-authority/);
  });

  it("does not fabricate qualification before a current v4 engine is registered", async () => {
    const { prepare } = await setup();
    const body = await (await prepare()).json();
    expect(body.delegations).toHaveLength(3);
    expect(body.delegations.every((row: { runtimeQualified: boolean; mcpQualified: boolean }) => !row.runtimeQualified && !row.mcpQualified)).toBe(true);
  });

  it("returns only available environment providers and never their material", async () => {
    const { prepare, register } = await setup({ credentials: { mode: "environment", env: { ANTHROPIC_API_KEY: "fixture-only-private-key" } } });
    await register();
    const body = await (await prepare()).json();
    expect(body.delegations).toHaveLength(1);
    expect(body.delegations[0].kind).toBe("claude-api-key");
    expect(JSON.stringify(body)).not.toContain("fixture-only-private-key");
  });

  it("does not revive revoked/expired synthetic user authority or extend expiry on retry", async () => {
    let now = Date.now();
    const { cp, prepare } = await setup({ now: () => now });
    const first = await (await prepare()).json();
    now += 10;
    expect((await (await prepare()).json()).delegations).toEqual(first.delegations);
    cp.revokeActor();
    expect((await prepare()).status).toBe(401);
    const expired = await setup({ now: () => now });
    now += 24 * 60 * 60_000 + 1;
    expect((await expired.prepare()).status).toBe(401);
  });
});
