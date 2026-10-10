import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CloudAgentBootCredentialResponseSchema, CloudAgentWarmActorResponseSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { canonicalCloudLocalCommandWriterSealDescriptor } from "@zeros/protocol/cloud-local-mirror";
import { FIXTURE_REQUEST_OPERATIONS, FIXTURE_REQUEST_ROUTES } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/request-observations";
import { createFixtureControlPlane, type FixtureControlPlane } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/server";

const prefix = "/internal/v2/cloud-workspaces/engine/agent-boot/";
const bootPaths = ["bootstrap", "sync", "activate", "refresh", "actor-confirm", "warm-context"] as const;
const fixtures: FixtureControlPlane[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.close())); });
async function setup(configured = true) {
  let now = Date.now();
  const fixture = createFixtureControlPlane({ now: () => now, allowedModels: { claude: ["fixture-claude"] } }); fixtures.push(fixture);
  const runtime = { profile: "zeros-cloud-worker-v4" as const, runtimeId: `r1-${"a".repeat(64)}`, manifestSha256: "a".repeat(64),
    baseCompatibilityId: `bc1-${"b".repeat(64)}`, installerReceiptSha256: "c".repeat(64), bootId: randomUUID(), supervisorSessionId: randomUUID() };
  fixture.configureRuntime(runtime);
  if (configured) fixture.configureBootOwner({ fundingOwnerUserId: fixture.actor.userId, fundingOwnerEpoch: 1, actorFundingGrant: { kind: "owner" } });
  const { baseUrl } = await fixture.start();
  const { workspaceId, organizationId, generation, engineInstanceId } = fixture.identity;
  const scope = { workspaceId, organizationId, generation, engineInstanceId };
  const post = (path: string, body: unknown, bearer = fixture.authority().heartbeatToken, headers: Record<string, string> = {}) => fetch(`${baseUrl}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const register = (optIn = true, headers: Record<string, string> = {}) => post("/internal/v1/cloud-workspaces/engine/register", { ...fixture.identity, actorProtocolVersion: 2,
    agentCustomizationVersion: 3, agentRuntime: runtime }, fixture.runtimeTokens.registrationToken,
    { ...(optIn ? { "x-zeros-cloud-local-commands": "1" } : {}), ...headers });
  const boot = { ...scope, version: 1, mode: "boot-owner-v1" };
  const bootstrap = async () => CloudAgentBootCredentialResponseSchema.parse((await (await post(`${prefix}bootstrap`, boot)).json()).result);
  const reference = async () => { const b = await bootstrap(); return { ...boot, bootId: b.bootId, writerEpoch: b.writerEpoch }; };
  return { fixture, scope, post, register, boot, bootstrap, reference, advance: (ms: number) => { now += ms; } };
}

describe("boot/mirror HTTP fixture inventory", () => {
  it.each([
    ["bootBootstrap", "boot.bootstrap"], ["bootSync", "boot.sync"], ["bootActivate", "boot.activate"],
    ["bootRefresh", "boot.refresh"], ["actorConfirm", "actor.confirm"], ["warmContext", "context.warm"], ["mirror", "commands.mirror"],
  ])("exports owning route/operation %s %s", (route, operation) => {
    expect(FIXTURE_REQUEST_ROUTES).toContain(route); expect(FIXTURE_REQUEST_OPERATIONS).toContain(operation);
  });
  it("exports seal ingress in the owning immutable route/operation inventory", () => {
    expect(FIXTURE_REQUEST_ROUTES).toContain("seal"); expect(FIXTURE_REQUEST_OPERATIONS).toContain("commands.seal");
  });
});
describe("strict negotiated boot HTTP fixture", () => {
  it("classifies the real credential-control poll while preserving its unsupported404 response", async () => {
    const f = await setup(); await f.register(); const ref = await f.reference();
    const start = f.fixture.measurementCheckpoint();
    const response = await f.post("/internal/v2/cloud-workspaces/engine/agent-credential-controls", { ...ref, acknowledgements: [] });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "fixture_route_not_found" });
    const window = f.fixture.measurementWindow(start);
    expect(window.routeCounts).toEqual({ credentialControls: 1 });
    expect(window.operationArrivalCounts).toEqual({ "credentials.controls": 1 });
    expect(window.requests).toMatchObject([{ route: "credentialControls", operation: "credentials.controls", status: 404 }]);
  });
  it("does not assign a control operation to malformed or augmented control bodies", async () => {
    const f = await setup(); await f.register(); const ref = await f.reference();
    for (const body of [{ ...ref, acknowledgements: [], unexpected: "private-sentinel" }, { ...ref, acknowledgements: [null] }]) {
      const start = f.fixture.measurementCheckpoint();
      const response = await f.post("/internal/v2/cloud-workspaces/engine/agent-credential-controls", body);
      expect(response.status).toBe(404);
      const window = f.fixture.measurementWindow(start);
      expect(window.requests).toMatchObject([{ route: "credentialControls", operation: "unknown", status: 404 }]);
      expect(JSON.stringify(window)).not.toContain("private-sentinel");
    }
  });
  it("keeps valid control bodies on another path unknown and rejects the wrong private bearer", async () => {
    const f = await setup(); await f.register(); const ref = await f.reference();
    let start = f.fixture.measurementCheckpoint();
    expect((await f.post("/unrelated-control-fixture", { ...ref, acknowledgements: [] })).status).toBe(404);
    expect(f.fixture.measurementWindow(start).requests).toMatchObject([{ route: "unknown", operation: "unknown", status: 404 }]);
    start = f.fixture.measurementCheckpoint();
    expect((await f.post("/internal/v2/cloud-workspaces/engine/agent-credential-controls", { ...ref, acknowledgements: [] }, f.fixture.actorGrantToken)).status).toBe(401);
    expect(f.fixture.measurementWindow(start).requests).toMatchObject([{ route: "credentialControls", operation: "unknown", status: 401 }]);
  });
  it("reports legacy journal until actual activation without widening registration JSON", async () => {
    const f = await setup(); const registration = await f.register();
    expect(registration.status).toBe(200);
    expect(registration.headers.get("x-zeros-cloud-agent-journal")).toBe("legacy");
    expect(registration.headers.has("x-zeros-cloud-agent-source-writer")).toBe(false);
    const before = await registration.json();
    expect(Object.keys(before).sort()).toEqual(["audience", "durableRecordConnected", "engineInstanceId", "heartbeat", "leaseExpiresAtMs", "version"]);
    const ref = await f.reference();
    expect((await f.post(`${prefix}sync`, { ...ref, expectedCacheRevision: 1 })).status).toBe(200);
    const retry = await f.register();
    expect(retry.headers.get("x-zeros-cloud-agent-journal")).toBe("legacy");
    expect(retry.headers.has("x-zeros-cloud-agent-source-writer")).toBe(false);
    expect(await retry.json()).toEqual(before);
    expect(f.fixture.inspect().boot).toMatchObject({ negotiated: true, activated: false });
  });
  it.each([
    { activated: false, supplied: "local", expected: "legacy" },
    { activated: true, supplied: "legacy", expected: "local" },
  ])("reads journal mode from stored activation, ignoring supplied $supplied ($activated)", async ({ activated, supplied, expected }) => {
    const f = await setup(); const registration = await f.register(); const before = await registration.json();
    const ref = await f.reference();
    if (activated) expect((await f.post(`${prefix}activate`, { ...ref, expectedCacheRevision: 1 })).status).toBe(200);
    const retry = await f.register(true, { "x-zeros-cloud-agent-journal": supplied });
    expect(retry.status).toBe(200);
    expect(retry.headers.get("x-zeros-cloud-local-commands")).toBe("1");
    expect(retry.headers.get("x-zeros-cloud-agent-journal")).toBe(expected);
    expect(await retry.json()).toEqual(before);
    expect(f.fixture.inspect().boot).toMatchObject({ negotiated: true, activated });
  });
  it("publishes only the actual activated source writer and keeps it outside strict registration JSON", async () => {
    const f = await setup(); const registration = await f.register(); const before = await registration.json();
    const ref = await f.reference();
    const reserved = await f.register(true, { "x-zeros-cloud-agent-source-writer": randomUUID() });
    expect(reserved.headers.get("x-zeros-cloud-agent-journal")).toBe("legacy");
    expect(reserved.headers.has("x-zeros-cloud-agent-source-writer")).toBe(false);
    expect((await f.post(`${prefix}activate`, { ...ref, expectedCacheRevision: 1 })).status).toBe(200);
    const headerCases: Record<string, string>[] = [{}, { "x-zeros-cloud-agent-source-writer": randomUUID() }];
    for (const headers of headerCases) {
      const current = await f.register(true, headers);
      expect(current.status).toBe(200);
      expect(current.headers.get("x-zeros-cloud-agent-journal")).toBe("local");
      expect(current.headers.get("x-zeros-cloud-agent-source-writer")).toBe(f.fixture.activeBootScope().writerEpoch);
      expect(current.headers.get("x-zeros-cloud-agent-source-writer")).toBe(ref.writerEpoch);
      expect(await current.json()).toEqual(before);
    }
  });
  it("never advertises journal authority on rejected registration after activation", async () => {
    const f = await setup(); await f.register(); const ref = await f.reference();
    expect((await f.post(`${prefix}activate`, { ...ref, expectedCacheRevision: 1 })).status).toBe(200);
    const denied = await f.post("/internal/v1/cloud-workspaces/engine/register", {}, f.fixture.actorGrantToken,
      { "x-zeros-cloud-local-commands": "1", "x-zeros-cloud-agent-journal": "local" });
    expect(denied.status).toBe(401);
    expect(denied.headers.has("x-zeros-cloud-local-commands")).toBe(false);
    expect(denied.headers.has("x-zeros-cloud-agent-journal")).toBe(false);
    expect(denied.headers.has("x-zeros-cloud-agent-source-writer")).toBe(false);
    expect(f.fixture.inspect().boot).toMatchObject({ activated: true });
  });
  it("keeps registration JSON unchanged and acknowledges only explicit fixture-funded negotiated mode", async () => {
    const f = await setup(); const registration = await f.register();
    expect(registration.headers.get("x-zeros-cloud-local-commands")).toBe("1");
    expect(registration.status).toBe(200);
    const b = await f.bootstrap(); expect(b.fundingOwnerUserId).toBe(f.fixture.actor.userId);
    expect(b.providers).toHaveLength(3); expect((await f.fixture.inspect()).boot).toMatchObject({ activated: false });
    expect(() => f.fixture.activeBootScope()).toThrow("command_context_changed");
    const ref = await f.reference();
    const activated = await f.post(`${prefix}activate`, { ...ref, expectedCacheRevision: 1 }); expect(activated.status).toBe(200);
    expect((await activated.json()).result).toMatchObject({ activated: true, writerEpoch: b.writerEpoch });
    expect(f.fixture.activeBootScope()).toEqual({ ...f.scope, bootId: b.bootId, writerEpoch: b.writerEpoch,
      fundingOwnerUserId: f.fixture.actor.userId, fundingOwnerEpoch: 1 });
    expect((await f.post(`${prefix}sync`, { ...ref, expectedCacheRevision: 1 })).status).toBe(200);
    expect(() => f.fixture.configureBootOwner({ fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2, actorFundingGrant: null })).toThrow();
  });
  it.each([false, true])("preserves legacy when explicit funding configuration or opt-in is absent (%s)", configured => {
    return setup(configured).then(async f => {
      const registration = await f.register(!configured); expect(registration.status).toBe(200);
      expect(registration.headers.has("x-zeros-cloud-local-commands")).toBe(false);
      expect(registration.headers.has("x-zeros-cloud-agent-journal")).toBe(false);
      expect(registration.headers.has("x-zeros-cloud-agent-source-writer")).toBe(false);
      expect((await f.post(`${prefix}bootstrap`, f.boot)).status).toBe(409);
      const retry = await f.register();
      expect(retry.headers.has("x-zeros-cloud-local-commands")).toBe(false);
      expect(retry.headers.has("x-zeros-cloud-agent-journal")).toBe(false);
      expect(retry.headers.has("x-zeros-cloud-agent-source-writer")).toBe(false);
    });
  });
  it("checks engine bearer before private bodies, refuses extra fields/foreign binding and limits bodies", async () => {
    const f = await setup(); await f.register();
    for (const path of bootPaths) {
      const response = await f.post(`${prefix}${path}`, { private: "fixture-prose-not-public" }, f.fixture.actorGrantToken);
      expect(response.status).toBe(401); expect(await response.text()).not.toContain("fixture-prose-not-public");
    }
    expect((await f.post(`${prefix}bootstrap`, { ...f.boot, owner: randomUUID() })).status).toBe(422);
    expect((await f.post(`${prefix}bootstrap`, { ...f.boot, organizationId: randomUUID() })).status).toBe(401);
    expect((await f.post(`${prefix}bootstrap`, { ...f.boot, private: "x".repeat(16_384) })).status).toBe(413);
    expect((await f.post(`${prefix}bootstrap`, f.boot, f.fixture.authority().heartbeatToken, { "content-type": "text/plain" })).status).toBe(422);
    expect(JSON.stringify(f.fixture.inspect())).not.toContain("fixture-prose-not-public");
  });
  it("confirms recorded actors off Send but never revives revoked or expired engine authority", async () => {
    const f = await setup(); await f.register(); const ref = await f.reference();
    await f.post(`${prefix}activate`, { ...ref, expectedCacheRevision: 1 });
    const actor = { ...f.scope, grantToken: f.fixture.actorGrantToken };
    expect((await f.post("/internal/v2/cloud-workspaces/engine/client-admission", actor)).status).toBe(200);
    f.advance(30_001);
    const body = { ...ref, actorSessionId: f.fixture.actor.sessionId };
    expect((await f.post(`${prefix}actor-confirm`, body)).status).toBe(200);
    const warm = await f.post(`${prefix}warm-context`, { ...body, provider: "claude", model: "fixture-claude", conversationId: "chat", cwd: "/fixture/workspace", repositoryServers: [] });
    expect(warm.status).toBe(200); CloudAgentWarmActorResponseSchema.parse((await warm.json()).result);
    f.fixture.revokeActor(); expect((await f.post(`${prefix}actor-confirm`, body)).status).toBe(403);
    f.advance(30_000); expect((await f.post(`${prefix}bootstrap`, f.boot)).status).toBe(401);
  });
  it("records closed boot routes/operations through the real ingress counter", async () => {
    const f = await setup(); await f.register(); const start = f.fixture.measurementCheckpoint();
    const ref = await f.reference(); await f.post(`${prefix}activate`, { ...ref, expectedCacheRevision: 1 });
    const window = f.fixture.measurementWindow(start);
    expect(window.requests.map(row => row.operation)).toContain("boot.bootstrap");
    expect(window.requests.map(row => row.route)).toContain("bootActivate");
  });
  it("mirrors only the active exact writer and uses the strict private mirror envelope", async () => {
    const f = await setup(); await f.register(); const ref = await f.reference();
    const batch = { version: 1, bootId: ref.bootId, writerEpoch: ref.writerEpoch, batchId: randomUUID(), after: 0, through: 1,
      changes: [{ sequence: 1, conversationId: "chat", revision: 1, paused: false }] };
    const path = "/internal/v2/cloud-workspaces/engine/commands/mirror";
    expect((await f.post(path, { ...f.scope, batch })).status).toBe(401);
    await f.post(`${prefix}activate`, { ...ref, expectedCacheRevision: 1 });
    const start = f.fixture.measurementCheckpoint(), response = await f.post(path, { ...f.scope, batch });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ result: { version: 1, writerEpoch: ref.writerEpoch, batchId: batch.batchId, through: 1 } });
    expect((await f.post(path, { ...f.scope, batch, actorSessionId: randomUUID() })).status).toBe(422);
    expect((await f.post(path, { ...f.scope, batch: { ...batch, bootId: randomUUID() } })).status).toBe(409);
    expect((await f.post(path, { ...f.scope, batch }, f.fixture.actorGrantToken)).status).toBe(401);
    expect(f.fixture.measurementWindow(start).requests.some(row => row.route === "mirror" && row.operation === "commands.mirror")).toBe(true);
  });
  it("requires actual activation/current engine authority for an exact seal and counts denied ingress too", async () => {
    const f = await setup(); await f.register(); const ref = await f.reference();
    const scope = { ...f.scope, bootId: ref.bootId, writerEpoch: ref.writerEpoch, fundingOwnerUserId: f.fixture.actor.userId, fundingOwnerEpoch: 1 };
    const fields = { version: 1, scope, sealId: randomUUID(), sequence: 0, recordSequence: 0, eventSequence: 0, inventorySha256: "a".repeat(64) };
    const seal = { ...fields, sha256: createHash("sha256").update(canonicalCloudLocalCommandWriterSealDescriptor(fields)).digest("hex") };
    const path = "/internal/v2/cloud-workspaces/engine/commands/seal";
    expect((await f.post(path, { ...f.scope, seal })).status).toBe(401);
    await f.post(`${prefix}activate`, { ...ref, expectedCacheRevision: 1 });
    const start = f.fixture.measurementCheckpoint(), response = await f.post(path, { ...f.scope, seal });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { version: 1, sealId: seal.sealId, writerEpoch: ref.writerEpoch,
      sequence: 0, recordSequence: 0, eventSequence: 0, inventorySha256: seal.inventorySha256, sha256: seal.sha256 } });
    expect((await f.post(path, { ...f.scope, seal }, f.fixture.actorGrantToken)).status).toBe(401);
    expect((await f.post(path, { ...f.scope, seal, sourceRetired: true })).status).toBe(422);
    expect((await f.post(path, { ...f.scope, seal, private: "x".repeat(16 * 1024) })).status).toBe(413);
    expect(f.fixture.measurementWindow(start).requests.some(row => row.route === "seal" && row.operation === "commands.seal")).toBe(true);
  });
});
