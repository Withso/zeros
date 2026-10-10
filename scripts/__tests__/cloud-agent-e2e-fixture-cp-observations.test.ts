import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureControlPlane, type FixtureControlPlane, type FixtureOptions } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/server";

const fixtures: FixtureControlPlane[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.close())); });
async function setup(options: FixtureOptions = {}) {
  const cp = createFixtureControlPlane(options);
  fixtures.push(cp);
  const runtime = { profile: "zeros-cloud-worker-v4" as const, manifestSha256: "a".repeat(64), runtimeId: `r1-${"a".repeat(64)}`,
    baseCompatibilityId: `bc1-${"b".repeat(64)}`, installerReceiptSha256: "c".repeat(64), bootId: randomUUID(), supervisorSessionId: randomUUID() };
  cp.configureRuntime(runtime);
  const { baseUrl } = await cp.start();
  const post = (path: string, body: unknown, bearer = cp.authority().heartbeatToken) => fetch(`${baseUrl}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await post("/internal/v1/cloud-workspaces/engine/register", { ...cp.identity,
    actorProtocolVersion: 2, agentCustomizationVersion: 3, agentRuntime: runtime }, cp.runtimeTokens.registrationToken)).status).toBe(200);
  const { workspaceId, organizationId, generation, engineInstanceId } = cp.identity;
  return { cp, baseUrl, post, scope: { workspaceId, organizationId, generation, engineInstanceId } };
}

describe("fixture actual HTTP ingress measurement", () => {
  it("counts every denied, malformed, wrong-verb and unknown ingress without retaining private input", async () => {
    const { cp, baseUrl, post, scope } = await setup();
    const start = cp.measurementCheckpoint();
    expect((await post("/internal/v1/cloud-workspaces/engine/heartbeat", scope, "fixture-private-bearer")).status).toBe(401);
    expect((await fetch(`${baseUrl}/private-fixture-path?secret=private-query`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/internal/v1/cloud-workspaces/engine/commands`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${baseUrl}/internal/v1/cloud-workspaces/engine/heartbeat`, { method: "POST", headers: {
      authorization: `Bearer ${cp.authority().heartbeatToken}`, "content-type": "application/json" }, body: "{private-malformed" })).status).toBe(422);
    expect((await post("/internal/v1/cloud-workspaces/engine/heartbeat", scope)).status).toBe(200);
    const window = cp.measurementWindow(start);
    expect(window).toMatchObject({ ingressCount: 5, completionCount: 5, inFlightAtStart: 0, inFlightAtEnd: 0,
      routeCounts: { heartbeat: 3, commands: 1, unknown: 1 }, detailsComplete: true, countersComplete: true,
      operationArrivalCounts: { unknown: 4, "engine.heartbeat": 1 }, unknownCausalIngressCount: 5 });
    expect(window.requests.map(row => row.status)).toEqual([401, 404, 404, 422, 200]);
    expect(JSON.stringify(window)).not.toMatch(/private-|authorization|bearerToken|workspaceId|prompt|apiKey/);
  });

  it("counts delayed arrival immediately and retains pending-at-start work in the next window", async () => {
    const { cp, post, scope } = await setup({ requestDelay: [{ route: "heartbeat", delayMs: 80 }] });
    const start = cp.measurementCheckpoint();
    const pending = post("/internal/v1/cloud-workspaces/engine/heartbeat", scope);
    await expect.poll(() => cp.measurementCheckpoint().inFlight).toBe(1);
    const during = cp.measurementCheckpoint();
    expect(cp.measurementWindow(start, during)).toMatchObject({ ingressCount: 1, completionCount: 0,
      inFlightAtStart: 0, inFlightAtEnd: 1, routeCounts: { heartbeat: 1 } });
    expect((await pending).status).toBe(200);
    const later = cp.measurementWindow(during);
    expect(later).toMatchObject({ ingressCount: 0, completionCount: 1, inFlightAtStart: 1, inFlightAtEnd: 0 });
    expect(later.requests).toHaveLength(1);
    expect(later.requests[0]).toMatchObject({ route: "heartbeat", beganBeforeWindow: true, status: 200 });
  });

  it("preserves arrival order, distinct completion order and historical window cutoffs", async () => {
    const { cp, baseUrl, post, scope } = await setup({ requestDelay: [{ route: "heartbeat", delayMs: 80 }] });
    const start = cp.measurementCheckpoint();
    const slow = post("/internal/v1/cloud-workspaces/engine/heartbeat", scope);
    await expect.poll(() => cp.measurementCheckpoint().inFlight).toBe(1);
    expect((await fetch(`${baseUrl}/unknown`)).status).toBe(404);
    const end = cp.measurementCheckpoint();
    const historical = cp.measurementWindow(start, end);
    expect(historical.requests.map(row => row.route)).toEqual(["heartbeat", "unknown"]);
    expect(historical.requests[0]).toMatchObject({ operation: "unknown", completionSequence: null, status: null });
    expect((await slow).status).toBe(200);
    expect(cp.measurementWindow(start, end)).toEqual(historical);
    const complete = cp.measurementWindow(start);
    expect(complete.requests[0]!.completionSequence).toBeGreaterThan(complete.requests[1]!.completionSequence!);
    expect(complete.requests[0]!.completedAtUs).toBeGreaterThanOrEqual(complete.requests[0]!.arrivedAtUs);
  });

  it("keeps lifetime counters when its detail ring overflows and makes operation coverage unavailable", async () => {
    const { cp, baseUrl } = await setup({ requestObservationRetentionCount: 2 });
    const start = cp.measurementCheckpoint();
    for (let i = 0; i < 5; i++) expect((await fetch(`${baseUrl}/unknown-${i}`)).status).toBe(404);
    const window = cp.measurementWindow(start);
    expect(window).toMatchObject({ ingressCount: 5, completionCount: 5, routeCounts: { unknown: 5 },
      completionRouteCounts: { unknown: 5 }, countersComplete: true, detailsComplete: false, operationArrivalCounts: null,
      unknownCausalIngressCount: 5 });
    expect(window.requests).toHaveLength(2);
  });

  it("bounds the complete window as pending details and the retained arrival ring combine", async () => {
    const { cp, baseUrl, post, scope } = await setup({ requestObservationRetentionCount: 2,
      requestDelay: [{ route: "heartbeat", delayMs: 80 }] });
    const start = cp.measurementCheckpoint();
    const slow = [post("/internal/v1/cloud-workspaces/engine/heartbeat", scope), post("/internal/v1/cloud-workspaces/engine/heartbeat", scope)];
    await expect.poll(() => cp.measurementCheckpoint().inFlight).toBe(2);
    await fetch(`${baseUrl}/unknown-one`);
    await fetch(`${baseUrl}/unknown-two`);
    const window = cp.measurementWindow(start);
    expect(window.requests.length).toBeLessThanOrEqual(2);
    expect(window).toMatchObject({ ingressCount: 4, inFlightAtEnd: 2, detailsComplete: false, operationArrivalCounts: null,
      unknownCausalIngressCount: 4 });
    expect((await Promise.all(slow)).every(response => response.status === 200)).toBe(true);
  });

  it("uses one monotonic fixture clock and immutable owned checkpoints", async () => {
    const { cp } = await setup();
    const first = cp.measurementCheckpoint(), second = cp.measurementCheckpoint();
    expect(first.clockDomainId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.clockSource).toBe("node-process-hrtime");
    expect(first.atUs).toBeGreaterThan(0);
    expect(second.clockDomainId).toBe(first.clockDomainId);
    expect(second.atUs).toBeGreaterThanOrEqual(first.atUs);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.routeCounts)).toBe(true);
    expect(cp.measurementWindow(first, second)).toMatchObject({ ingressCount: 0, completionCount: 0 });
  });

  it("refuses foreign, cloned, fabricated-future and reversed checkpoints", async () => {
    const { cp, baseUrl } = await setup(), other = await setup();
    const first = cp.measurementCheckpoint();
    await fetch(`${baseUrl}/unknown`);
    const second = cp.measurementCheckpoint();
    for (const bad of [other.cp.measurementCheckpoint(), structuredClone(first), { ...first, ingressSequence: first.ingressSequence + 1000 }]) {
      expect(() => cp.measurementWindow(bad)).toThrow("fixture_measurement_checkpoint_invalid");
    }
    expect(() => cp.measurementWindow(second, first)).toThrow("fixture_measurement_checkpoint_invalid");
  });

  it("counts the real public renderer prepare trip and sanitizes its workspace path", async () => {
    const { cp, baseUrl } = await setup();
    const start = cp.measurementCheckpoint();
    const response = await fetch(`${baseUrl}/v1/cloud-workspaces/${cp.identity.workspaceId}/agent-credentials/prepare`, {
      method: "POST", headers: { authorization: `Bearer ${cp.rendererAuthority().bearerToken}`, "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(200);
    const window = cp.measurementWindow(start);
    expect(window).toMatchObject({ ingressCount: 1, completionCount: 1, routeCounts: { rendererPrepare: 1 },
      operationArrivalCounts: { "renderer.prepare": 1 }, unknownCausalIngressCount: 1 });
    expect(JSON.stringify(window)).not.toContain(cp.identity.workspaceId);
  });

  it("delays only the exact configured body operation while counting arrivals before parsing", async () => {
    const { cp, post, scope } = await setup({ requestDelay: [{ route: "commands", operation: "commands.snapshot", delayMs: 80 }] });
    const start = cp.measurementCheckpoint();
    const slow = post("/internal/v1/cloud-workspaces/engine/commands", { ...scope, actorSessionId: cp.actor.sessionId,
      request: { kind: "snapshot", conversationId: "fixture-conversation" } });
    await expect.poll(() => cp.measurementCheckpoint().inFlight).toBe(1);
    expect((await post("/internal/v1/cloud-workspaces/engine/commands", { ...scope, actorSessionId: cp.actor.sessionId,
      request: { kind: "read", commandId: randomUUID() } })).status).toBe(403);
    const during = cp.measurementWindow(start);
    expect(during).toMatchObject({ ingressCount: 2, completionCount: 1, inFlightAtEnd: 1 });
    expect((await slow).status).toBe(403);
    expect(cp.measurementWindow(start).completionOperationCounts).toMatchObject({ "commands.snapshot": 1, "commands.read": 1 });
  });

  it("does not stretch engine authority when injected delay crosses its existing deadline", async () => {
    let now = Date.now();
    const { cp, post, scope } = await setup({ now: () => now, engineLeaseMs: 5000, requestDelay: [{ route: "heartbeat", delayMs: 80 }] });
    const start = cp.measurementCheckpoint();
    const pending = post("/internal/v1/cloud-workspaces/engine/heartbeat", scope);
    await expect.poll(() => cp.measurementCheckpoint().inFlight).toBe(1);
    now += 5001;
    expect((await pending).status).toBe(401);
    expect(cp.measurementWindow(start)).toMatchObject({ ingressCount: 1, completionCount: 1, inFlightAtEnd: 0 });
  });

  it("drains aborted/closed delayed requests without hidden handlers or lifetime loss", async () => {
    const { cp, baseUrl, scope } = await setup({ requestDelay: [{ route: "heartbeat", delayMs: 4000 }] });
    const start = cp.measurementCheckpoint();
    const abort = new AbortController();
    const pending = fetch(`${baseUrl}/internal/v1/cloud-workspaces/engine/heartbeat`, { method: "POST", signal: abort.signal,
      headers: { authorization: `Bearer ${cp.authority().heartbeatToken}`, "content-type": "application/json" }, body: JSON.stringify(scope) }).catch(() => null);
    await expect.poll(() => cp.measurementCheckpoint().inFlight).toBe(1);
    abort.abort();
    await cp.close();
    await pending;
    expect(cp.measurementWindow(start)).toMatchObject({ ingressCount: 1, completionCount: 1, inFlightAtEnd: 0, activeHandlers: 0 });
  });

  it.each([
    [{ route: "heartbeat", delayMs: -1 }],
    [{ route: "heartbeat", delayMs: 5001 }],
    [{ route: "private-arbitrary-route", delayMs: 1 }],
    [{ route: "commands", operation: "engine.register", delayMs: 1 }],
    [{ route: "heartbeat", delayMs: 1 }, { route: "heartbeat", delayMs: 2 }],
    [{ route: "commands", delayMs: 3000 }, { route: "commands", operation: "commands.snapshot", delayMs: 3000 }],
  ].map(selectors => ({ selectors })))("rejects invalid or duplicate unbounded delay selectors: %j", ({ selectors }) => {
    // Deliberately invalid configuration crosses the runtime validation port.
    expect(() => createFixtureControlPlane({ requestDelay: selectors as unknown as NonNullable<FixtureOptions["requestDelay"]> }))
      .toThrow("fixture_request_delay_invalid");
  });
});
