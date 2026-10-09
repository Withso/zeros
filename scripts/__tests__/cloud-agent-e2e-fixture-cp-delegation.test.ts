import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CloudAgentExecutionAuthoritySchema, CloudAgentExecutionLeaseSchema } from "@zeros/protocol/cloud-agent-execution";
import { requestCloudCommand } from "../../apps/desktop/src/engine/cloud-command-client";
import { createFixtureControlPlane, type FixtureControlPlane } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/server";

const fixtures: FixtureControlPlane[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.close())); });

async function setup() {
  const start = Date.now();
  let now = start;
  const fixture = createFixtureControlPlane({ now: () => now, engineLeaseMs: 600_000, allowedModels: { claude: ["fixture-claude-model"] } });
  fixtures.push(fixture);
  const runtime = { profile: "zeros-cloud-worker-v4" as const, manifestSha256: "a".repeat(64), runtimeId: `r1-${"a".repeat(64)}`,
    baseCompatibilityId: `bc1-${"b".repeat(64)}`, installerReceiptSha256: "c".repeat(64), bootId: randomUUID(), supervisorSessionId: randomUUID() };
  fixture.configureRuntime(runtime);
  const { baseUrl } = await fixture.start();
  const { workspaceId, organizationId, generation, engineInstanceId } = fixture.identity;
  const scope = { workspaceId, organizationId, generation, engineInstanceId };
  const post = (path: string, body: unknown, bearer = fixture.authority().heartbeatToken) => fetch(`${baseUrl}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await post("/internal/v1/cloud-workspaces/engine/register", { ...fixture.identity,
    actorProtocolVersion: 2, agentCustomizationVersion: 3, agentRuntime: runtime }, fixture.runtimeTokens.registrationToken)).status).toBe(200);
  expect((await post("/internal/v2/cloud-workspaces/engine/client-admission", { ...scope, grantToken: fixture.actorGrantToken })).status).toBe(200);
  const commandId = randomUUID(), conversationId = randomUUID(), executionId = randomUUID(), claimId = randomUUID();
  const call = (request: Parameters<typeof requestCloudCommand>[1]) => requestCloudCommand(fixture.authority(), request,
    new AbortController().signal, fetch, fixture.actor.sessionId);
  await call({ kind: "mutate", admissionError: null, mutation: { conversationId, operationId: randomUUID(), expectedRevision: 0,
    action: { kind: "enqueue", commandId, payload: { agentId: "claude", userMessageId: commandId, prompt: [{ type: "text", text: "fixture" }],
      modeRevision: 0, model: "fixture-claude-model", agentCredentialGrantId: fixture.delegationId("claude"), permissionMode: "bypass" } } } });
  await call({ kind: "claim", conversationId, executionId, claimId });
  const preparePath = `/v1/cloud-workspaces/${workspaceId}/agent-credentials/prepare`;
  const prepare = () => post(preparePath, {}, fixture.rendererAuthority().bearerToken);
  const metadata = await (await prepare()).json();
  const expiresAt = Date.parse(metadata.delegations.find((row: { kind: string }) => row.kind === "claude-api-key").expiresAt);
  const request = { kind: "admit" as const, environmentVersion: 1 as const, admission: { executionId,
    delegationId: fixture.delegationId("claude"), provider: "claude" as const, model: "fixture-claude-model",
    source: { kind: "command" as const, commandId, claimId } } };
  const execute = (value: unknown) => post("/internal/v2/cloud-workspaces/engine/agent-execution", { ...scope, request: value });
  const moveNearExpiry = async (remainingMs: number) => {
    now = start + 9 * 60_000;
    expect((await post("/internal/v1/cloud-workspaces/engine/heartbeat", scope)).status).toBe(200);
    now = expiresAt - remainingMs;
  };
  return { fixture, baseUrl, preparePath, prepare, expiresAt, execute, request, moveNearExpiry,
    setNow: (value: number) => { now = value; } };
}

describe("fixture public/private delegation deadline consistency", () => {
  it("clamps admission and renewal to the exposed deadline without extending it on retry", async () => {
    const state = await setup();
    await state.moveNearExpiry(40_000);
    const authority = CloudAgentExecutionAuthoritySchema.parse(await (await state.execute(state.request)).json().then(value => value.result));
    expect(Date.parse(authority.expiresAt)).toBe(state.expiresAt);
    state.setNow(state.expiresAt - 39_000);
    const retried = await (await state.execute(state.request)).json();
    expect(retried.result.leaseId).toBe(authority.leaseId);
    expect(Date.parse(retried.result.expiresAt)).toBe(state.expiresAt);
    const renewed = CloudAgentExecutionLeaseSchema.parse((await (await state.execute({ kind: "validate", leaseId: authority.leaseId, renew: true })).json()).result);
    expect(Date.parse(renewed.expiresAt)).toBe(state.expiresAt);
    const metadata = await (await state.prepare()).json();
    expect(metadata.delegations.every((row: { expiresAt: string }) => Date.parse(row.expiresAt) === state.expiresAt)).toBe(true);
  });

  it.each([5000, 4999, 0, -1])("refuses admission with only %i ms of delegation remaining", async remaining => {
    const state = await setup();
    await state.moveNearExpiry(remaining);
    const response = await state.execute(state.request);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cloud_agent_authority_rejected" });
  });

  it.each([false, true])("refuses validation renew=%s at the actual CP minimum remaining deadline", async renew => {
    const state = await setup();
    await state.moveNearExpiry(5001);
    const authority = CloudAgentExecutionAuthoritySchema.parse((await (await state.execute(state.request)).json()).result);
    state.setNow(state.expiresAt - 5000);
    const response = await state.execute({ kind: "validate", leaseId: authority.leaseId, renew });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cloud_agent_authority_rejected" });
  });

  it("does not revive the expired grant via admission retry or renewal and keeps release idempotent", async () => {
    const state = await setup();
    await state.moveNearExpiry(6000);
    const authority = CloudAgentExecutionAuthoritySchema.parse((await (await state.execute(state.request)).json()).result);
    state.setNow(state.expiresAt + 1);
    expect((await state.execute(state.request)).status).toBe(403);
    expect((await state.execute({ kind: "validate", leaseId: authority.leaseId, renew: true })).status).toBe(403);
    expect((await (await state.prepare()).json()).delegations).toEqual([]);
    expect((await state.execute({ kind: "release", leaseId: authority.leaseId })).status).toBe(200);
    expect((await state.execute({ kind: "release", leaseId: authority.leaseId })).status).toBe(200);
  });

  it("enforces the real public prepare route's 16 KiB body limit", async () => {
    const { fixture, baseUrl, preparePath } = await setup();
    const response = await fetch(`${baseUrl}${preparePath}`, { method: "POST", headers: {
      authorization: `Bearer ${fixture.rendererAuthority().bearerToken}`, "content-type": "application/json" },
      body: "{}" + " ".repeat(16 * 1024) });
    expect(response.status).toBe(413);
  });
});
