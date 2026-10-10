import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CloudAgentBootCredentialResponseSchema, CloudAgentBootActivateResponseSchema, CloudAgentActorConfirmResponseSchema,
  CloudAgentWarmActorResponseSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { cloudMcpDigest } from "../../apps/desktop/src/engine/agents/cloud-mcp";
import { CloudActorAuthorityRegistry, CLOUD_ACTOR_AUTHORITY_MAX_MS } from "../../apps/desktop/src/engine/agents/cloud-actor-authority";
import { CloudAgentContextCache } from "../../apps/desktop/src/engine/agents/cloud-provider-execution";
import { FixtureBootAuthority } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/boot";
import { FixtureRefusal } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/contracts";

function setup(options: { consent?: boolean; owner?: boolean; role?: "developer" | "viewer"; engineLeaseMs?: number; actorLeaseMs?: number;
  credentials?: { mode: "synthetic" | "environment"; env?: Record<string, string> } } = {}) {
  let now = Date.now(), recorded = true, live = true;
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
  const actor = { userId: randomUUID(), deviceId: randomUUID(), deviceKeyVersion: 1, role: options.role ?? "developer" as const, fingerprint: "a".repeat(64) };
  const actorSessionId = randomUUID(), bootId = randomUUID();
  const authority = new FixtureBootAuthority({ scope, now: () => now, engineLive: () => live,
    engineDeadline: () => now + (options.engineLeaseMs ?? 60_000), actorSessionExpiresAt: () => now + (options.actorLeaseMs ?? 24 * 60 * 60_000),
    configuration: { fundingOwnerUserId: options.owner ? actor.userId : randomUUID(), fundingOwnerEpoch: 1,
      actorFundingGrant: options.consent === false ? null : options.owner ? { kind: "owner" } : { kind: "share", grantId: randomUUID(), grantRevision: 1 } },
    actorSessionId, recordedActor: (session: string) => {
      if (!recorded || session !== actorSessionId) throw new FixtureRefusal("cloud_actor_authority_rejected", 403);
      return actor;
    }, credentials: options.credentials, allowedModels: { claude: ["fixture-claude"], codex: ["fixture-codex"], cursor: ["fixture-cursor"] } });
  const request = { ...scope, version: 1 as const, mode: "boot-owner-v1" as const };
  const negotiate = () => authority.negotiateRegistration(bootId, true, true);
  const bootstrap = () => CloudAgentBootCredentialResponseSchema.parse(authority.handle("bootstrap", request));
  const reference = () => { const boot = bootstrap(); return { ...request, bootId: boot.bootId, writerEpoch: boot.writerEpoch }; };
  const activate = () => authority.handle("activate", { ...reference(), expectedCacheRevision: 1 });
  return { scope, actor, actorSessionId, bootId, authority, request, negotiate, bootstrap, reference, activate,
    now: () => now, advance: (ms: number) => { now += ms; }, revoke: () => { recorded = false; }, retire: () => { live = false; } };
}

describe("production-schema boot fixture authority", () => {
  it("reserves a stable CP-owned writer only after explicit qualified registration and bootstrap", () => {
    const f = setup();
    expect(() => f.bootstrap()).toThrow("cloud_runtime_upgrade_required");
    expect(f.authority.inspect()).toMatchObject({ negotiated: false, activated: false, providerCount: 0 });
    expect(f.negotiate()).toBe(true);
    const first = f.bootstrap(); expect(f.bootstrap()).toEqual(first);
    expect(first.bootId).toBe(f.bootId); expect(first.fundingOwnerUserId).not.toBe(f.actor.userId);
    expect(first.initialAdoptions).toHaveLength(3); expect(first.providers).toHaveLength(3);
    expect(first.providers.every(row => row.status === "ready")).toBe(true);
    expect(f.authority.inspect()).toMatchObject({ activated: false, providerCount: 3 });
  });
  it.each([false, true])("never upgrades an initially unnegotiated registration on retry (%s)", qualified => {
    const f = setup(); expect(f.authority.negotiateRegistration(f.bootId, false, qualified)).toBe(false);
    expect(f.negotiate()).toBe(false); expect(() => f.bootstrap()).toThrow("cloud_runtime_upgrade_required");
  });
  it("requires qualification and preserves the persisted boot on registration retries", () => {
    const f = setup(); expect(f.authority.negotiateRegistration(f.bootId, true, false)).toBe(false);
    expect(f.negotiate()).toBe(false);
    const valid = setup(); valid.negotiate();
    expect(() => valid.authority.negotiateRegistration(randomUUID(), true, true)).toThrow("command_context_changed");
  });
  it.each(["workspaceId", "organizationId", "engineInstanceId"] as const)("refuses a foreign bootstrap %s and account selectors", field => {
    const f = setup(); f.negotiate();
    expect(() => f.authority.handle("bootstrap", { ...f.request, [field]: randomUUID() })).toThrow("engine_authority_rejected");
    expect(() => f.authority.handle("bootstrap", { ...f.request, fundingOwnerUserId: f.actor.userId })).toThrow("invalid_request");
  });
  it("activation is separate, exact, idempotent and refuses stale epochs/cache", () => {
    const f = setup(); f.negotiate(); const ref = f.reference();
    expect(f.authority.inspect().activated).toBe(false);
    expect(() => f.authority.handle("activate", { ...ref, writerEpoch: randomUUID(), expectedCacheRevision: 1 })).toThrow("command_context_changed");
    expect(() => f.authority.handle("activate", { ...ref, expectedCacheRevision: 2 })).toThrow("cloud_agent_credential_refresh_required");
    const activated = CloudAgentBootActivateResponseSchema.parse(f.activate());
    expect(activated.activated).toBe(true); expect(f.activate()).toEqual(activated);
    f.retire(); expect(() => f.activate()).toThrow("engine_authority_rejected");
  });
  it("dirty current-only snapshots never replay superseded native material and need a background publication", () => {
    const f = setup(); f.negotiate(); const old = f.bootstrap(), ref = f.reference();
    f.authority.markDesiredRevision(2);
    const dirty = CloudAgentBootCredentialResponseSchema.parse(f.authority.handle("sync", { ...ref, expectedCacheRevision: 1 }));
    expect(dirty).toMatchObject({ cacheRevision: 1, desiredCacheRevision: 2 });
    expect(dirty.providers.every(row => row.status === "unavailable")).toBe(true);
    expect(f.bootstrap().providers.every(row => row.status === "unavailable")).toBe(true);
    expect(() => f.activate()).toThrow("cloud_agent_credential_refresh_required");
    f.authority.publishDesiredRevision();
    const next = f.bootstrap(); expect(next.cacheRevision).toBe(2); expect(next.providers.every(row => row.status === "ready")).toBe(true);
    expect(next.initialAdoptions).toEqual(old.initialAdoptions); expect(next.writerEpoch).toBe(old.writerEpoch);
    expect(() => f.authority.handle("sync", { ...ref, expectedCacheRevision: 3 })).toThrow("cloud_agent_credential_refresh_required");
  });
  it("uses only explicitly projected credentials and never falls back to ambient or another provider", () => {
    const f = setup({ credentials: { mode: "environment", env: {} } }); f.negotiate();
    expect(f.bootstrap().providers.every(row => row.status === "unavailable" && row.code === "cloud_agent_credential_required")).toBe(true);
    expect(f.bootstrap().initialAdoptions.every(row => row.status === "missing")).toBe(true);
    const invalid = setup({ credentials: { mode: "environment", env: { OPENAI_API_KEY: "\u0000fixture-private" } } });
    invalid.negotiate(); expect(() => invalid.bootstrap()).toThrow(/^fixture_credential_invalid$/);
    expect(JSON.stringify(invalid.authority.inspect())).not.toContain("fixture-private");
  });
  it("does not invent a Codex subscription refresh for API-key or absent fixture material", () => {
    const f = setup(); f.negotiate(); const snapshot = f.bootstrap(), codex = snapshot.providers.find(row => row.provider === "codex");
    expect(codex?.status).toBe("ready");
    if (codex?.status !== "ready") throw new Error("fixture shape invalid");
    expect(() => f.authority.handle("refresh", { ...f.reference(), provider: "codex", credentialId: codex.credentialId,
      credentialRevision: codex.credentialRevision, expectedCacheRevision: 1, expectedMaterialVersion: 1 })).toThrow("cloud_agent_credential_refresh_required");
  });
  it("confirms only recorded live actors and keeps funding provenance independent of the sender", () => {
    const f = setup(); f.negotiate(); f.activate();
    const body = { ...f.reference(), actorSessionId: f.actorSessionId };
    const response = CloudAgentActorConfirmResponseSchema.parse(f.authority.handle("actor-confirm", body));
    expect(response.provenance.actor).toEqual(f.actor); expect(response.provenance.scope.fundingOwnerUserId).not.toBe(f.actor.userId);
    expect(response.provenance.fundingGrant?.kind).toBe("share");
    expect(response.provenance.confirmedUntilMs - f.now()).toBe(CLOUD_ACTOR_AUTHORITY_MAX_MS);
    expect(() => f.authority.handle("actor-confirm", { ...body, actorSessionId: randomUUID() })).toThrow("cloud_actor_authority_rejected");
    f.revoke(); expect(() => f.authority.handle("actor-confirm", body)).toThrow("cloud_actor_authority_rejected");
  });
  it.each(["actor-confirm", "warm-context"] as const)("%s proof is accepted by the real bounded engine actor registry", operation => {
    const f = setup({ owner: true }); f.negotiate(); f.activate();
    const base = { ...f.reference(), actorSessionId: f.actorSessionId };
    const proof = operation === "actor-confirm"
      ? CloudAgentActorConfirmResponseSchema.parse(f.authority.handle(operation, base)).provenance
      : CloudAgentWarmActorResponseSchema.parse(f.authority.handle(operation, { ...base, provider: "claude", model: "fixture-claude",
        conversationId: "chat", cwd: "/fixture/workspace", repositoryServers: [] })).actor;
    const registry = new CloudActorAuthorityRegistry({ scope: proof.scope, engineLive: () => true,
      time: { wall: f.now, monotonic: f.now } });
    try {
      expect(() => registry.confirm(proof).assertLive("run")).not.toThrow();
      expect(proof.confirmedUntilMs - f.now()).toBe(CLOUD_ACTOR_AUTHORITY_MAX_MS);
    } finally { registry.dispose(); }
  });
  it.each([{ engineLeaseMs: 7000 }, { actorLeaseMs: 4000 }])("caps actor proof at the earlier exact engine/session deadline %#", options => {
    const f = setup(options); f.negotiate(); f.activate();
    const proof = CloudAgentActorConfirmResponseSchema.parse(f.authority.handle("actor-confirm", { ...f.reference(), actorSessionId: f.actorSessionId })).provenance;
    expect(proof.confirmedUntilMs - f.now()).toBe(options.engineLeaseMs ?? options.actorLeaseMs);
  });
  it.each([{ consent: false }, { role: "viewer" as const }])("rejects warm execution without actual run consent/role %#", options => {
    const f = setup(options); f.negotiate(); f.activate();
    expect(() => f.authority.handle("warm-context", { ...f.reference(), actorSessionId: f.actorSessionId, provider: "claude",
      model: "fixture-claude", conversationId: "chat", cwd: "/fixture/workspace", repositoryServers: [] })).toThrow("cloud_agent_authority_rejected");
  });
  it("renews only the fresh actor deadline of the same live warm context", () => {
    const f = setup({ owner: true }); f.negotiate(); f.activate();
    const body = { ...f.reference(), actorSessionId: f.actorSessionId, provider: "codex", model: "fixture-codex",
      conversationId: "chat", cwd: "/fixture/workspace", repositoryServers: [] };
    const first = CloudAgentWarmActorResponseSchema.parse(f.authority.handle("warm-context", body));
    f.advance(5000);
    const second = CloudAgentWarmActorResponseSchema.parse(f.authority.handle("warm-context", body));
    expect(second.contextId).toBe(first.contextId); expect(second.contextRevision).toBe(first.contextRevision);
    expect(second.actor.confirmedUntilMs).toBe(first.actor.confirmedUntilMs + 5000);
    expect({ ...second, actor: first.actor }).toEqual(first);
  });
  it("background fixture renewal keeps the original real engine context live beyond its first deadline", async () => {
    const f = setup({ owner: true }); f.negotiate(); f.activate();
    const cwd = await mkdtemp(join(tmpdir(), "zeros-fixture-context-"));
    const proof = CloudAgentActorConfirmResponseSchema.parse(f.authority.handle("actor-confirm", {
      ...f.reference(), actorSessionId: f.actorSessionId })).provenance;
    const time = { wall: f.now, monotonic: f.now };
    const registry = new CloudActorAuthorityRegistry({ scope: proof.scope, time, engineLive: () => true });
    const cache = new CloudAgentContextCache({ scope: proof.scope, registry, time, engineLive: () => true,
      isAdmittedCwd: value => value === cwd, request: async body => f.authority.handle("warm-context", body) });
    try {
      const actor = registry.confirm(proof);
      const input = { actor, provider: "codex" as const, conversationId: "chat", model: "fixture-codex", cwd };
      const original = await cache.warm(input);
      f.advance(5000);
      registry.confirm(CloudAgentActorConfirmResponseSchema.parse(f.authority.handle("actor-confirm", {
        ...f.reference(), actorSessionId: f.actorSessionId })).provenance);
      expect(await cache.warm(input)).toBe(original);
      f.advance(6000);
      expect(() => original.assertLive()).not.toThrow(); expect(original.signal.aborted).toBe(false);
    } finally { cache.dispose(); registry.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });
  it("remints expired warm context identity and never returns a cached proof after actor revocation", () => {
    const f = setup({ owner: true }); f.negotiate(); f.activate();
    const body = { ...f.reference(), actorSessionId: f.actorSessionId, provider: "codex", model: "fixture-codex",
      conversationId: "chat", cwd: "/fixture/workspace", repositoryServers: [] };
    const first = CloudAgentWarmActorResponseSchema.parse(f.authority.handle("warm-context", body));
    f.advance(CLOUD_ACTOR_AUTHORITY_MAX_MS + 1);
    const second = CloudAgentWarmActorResponseSchema.parse(f.authority.handle("warm-context", body));
    expect(second.contextId).not.toBe(first.contextId); expect(second.contextRevision).toBe(first.contextRevision);
    f.revoke(); expect(() => f.authority.handle("warm-context", body)).toThrow("cloud_actor_authority_rejected");
  });
  it("returns exact schema-bound warm context/history/environment/MCP and stable identity", () => {
    const f = setup({ owner: true }); f.negotiate(); f.activate();
    const server = { transport: "stdio" as const, name: "fixture-server", command: "fixture-command", args: [], env: {} };
    const body = { ...f.reference(), actorSessionId: f.actorSessionId, provider: "claude", model: "fixture-claude",
      conversationId: "chat", cwd: "/fixture/workspace", repositoryServers: [] };
    const value = CloudAgentWarmActorResponseSchema.parse(f.authority.handle("warm-context", body));
    expect(value.actor.fundingGrant?.kind).toBe("owner"); expect(value.actor.actor.userId).toBe(f.actor.userId);
    expect(value.customization?.servers).toEqual([]); expect(value.customization?.repositoryDigest).toBe(cloudMcpDigest([]));
    expect(value.customization?.history).toEqual(value.environment.history);
    expect(f.authority.handle("warm-context", body)).toEqual(value);
    expect(() => f.authority.handle("warm-context", { ...body, model: "foreign-model" })).toThrow("cloud_agent_model_not_authorized");
    expect(() => f.authority.handle("warm-context", { ...body, cwd: "/fixture/../escape" })).toThrow("invalid_request");
    expect(f.authority.handle("warm-context", { ...body, repositoryServers: [server] })).not.toEqual(value);
    f.advance(30_001);
    const renewed = CloudAgentWarmActorResponseSchema.parse(f.authority.handle("warm-context", body));
    expect(renewed.actor.confirmedUntilMs).toBeGreaterThan(value.actor.confirmedUntilMs);
  });
  it("keeps inspection metadata-only and erases private slots on close", () => {
    const f = setup(); f.negotiate(); const response = f.bootstrap();
    const serialized = JSON.stringify(f.authority.inspect());
    expect(serialized).not.toContain("material"); expect(serialized).not.toContain("apiKey");
    for (const slot of response.providers) if (slot.status === "ready" && "apiKey" in slot.material) expect(serialized).not.toContain(slot.material.apiKey);
    f.authority.close(); f.authority.close(); expect(f.authority.inspect().providerCount).toBe(0);
    expect(() => f.bootstrap()).toThrow("engine_authority_rejected");
  });
});
