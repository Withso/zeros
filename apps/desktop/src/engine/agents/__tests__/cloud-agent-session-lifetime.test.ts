import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudActorAuthorityRegistry } from "../cloud-actor-authority";
import type { CloudAgentCredentialCache } from "../cloud-agent-credential-cache";
import type { CloudAgentSessionLifetime } from "../cloud-agent-session-lifetime";

const handles: { close(): Promise<void> }[] = [], caches: CloudAgentCredentialCache[] = [], actors: CloudActorAuthorityRegistry[] = [];
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map(value => value.close()));
  for (const cache of caches.splice(0)) cache.dispose(); for (const actor of actors.splice(0)) actor.dispose();
  vi.useRealTimers();
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture() {
  const cachePath = "../cloud-agent-credential-cache", lifetimePath = "../cloud-agent-session-lifetime";
  const { CloudAgentCredentialCache } = await import(cachePath) as typeof import("../cloud-agent-credential-cache");
  const { CloudAgentSessionLifetime } = await import(lifetimePath) as typeof import("../cloud-agent-session-lifetime");
  let wall = 1_791_468_000_000, monotonic = 1000, live = true;
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 7, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2 };
  const time = { wall: () => wall, monotonic: () => monotonic }, engineLive = () => live;
  const registry = new CloudActorAuthorityRegistry({ scope, time, engineLive }); actors.push(registry);
  const provenance = { scope, actorSessionId: randomUUID(), authorityEpoch: 3, confirmedUntilMs: wall + 10_000,
    actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1, role: "owner", fingerprint: "a".repeat(64) },
    fundingConsentVersion: 1, fundingGrant: { kind: "owner" } };
  const actor = registry.confirm(provenance);
  const response = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", authorityEpoch: 3,
    cacheRevision: 1, desiredCacheRevision: 1,
    initialAdoptions: ["claude", "cursor", "codex"].map(provider => ({ provider, status: "unknown" })),
    providers: [{ provider: "claude", status: "ready", credentialId: randomUUID(), credentialRevision: 1, connectionRevision: 1,
      adoptionId: randomUUID(), displayName: "Test account", kind: "claude-api-key", models: ["qualified-model"], materialVersion: 1,
      expiresAt: null, refreshAfter: null, authorityExpiresAt: null,
      nativeCapabilities: { version: 1, goals: false, nativeFork: false, transcriptFork: false, nativeReview: false, connectedApps: false, multiAgent: false },
      material: { kind: "claude-api-key", apiKey: "synthetic-private-provider-A" } },
    { status: "unavailable", provider: "cursor", code: "cloud_agent_credential_required" },
    { status: "unavailable", provider: "codex", code: "cloud_agent_credential_required" }] };
  const request = { bootstrap: vi.fn(async () => response), sync: vi.fn(async () => response) };
  const cache = new CloudAgentCredentialCache({ scope, time, engineLive, request }); caches.push(cache); await cache.initialize();
  const supervisor = { onRetirementFailure: vi.fn() };
  const create = () => {
    const credential = cache.capture("claude", "qualified-model");
    const lifetime = new CloudAgentSessionLifetime({ actor, credential, engineLive, supervisor }); handles.push(lifetime);
    return { lifetime, credential };
  };
  return { create, actor, registry, cache, request, supervisor, CloudAgentSessionLifetime, engineLive,
    advance: (value: number) => { wall += value; monotonic += value; }, loseAuthority: () => { live = false; } };
}

describe("locally fenced cloud conversation lifetime", () => {
  it("requires genuine opaque actor and credential captures rather than caller method shapes", async () => {
    const f = await fixture(), { credential } = f.create();
    expect(() => new f.CloudAgentSessionLifetime({ actor: { ...f.actor } as typeof f.actor, credential,
      engineLive: f.engineLive, supervisor: f.supervisor })).toThrow();
    expect(() => new f.CloudAgentSessionLifetime({ actor: f.actor, credential: { ...credential } as typeof credential,
      engineLive: f.engineLive, supervisor: f.supervisor })).toThrow();
  });
  it("normal live assertions do no CP validation/renewal/release", async () => {
    const f = await fixture(), { lifetime } = f.create();
    f.request.bootstrap.mockClear(); lifetime.assertLive(); lifetime.assertLive(); await lifetime.close();
    expect(f.request.bootstrap).not.toHaveBeenCalled(); expect(f.request.sync).not.toHaveBeenCalled();
    expect(lifetime).not.toHaveProperty("leaseId"); expect(lifetime).not.toHaveProperty("validate");
  });
  it("Stop positively retires only the exact conversation and keeps sibling/cache authority", async () => {
    const f = await fixture(), a = f.create(), b = f.create(), stopA = vi.fn(async () => {}), stopB = vi.fn(async () => {});
    a.lifetime.attach({ stopAndProve: stopA }); b.lifetime.attach({ stopAndProve: stopB });
    await a.lifetime.close(); expect(stopA).toHaveBeenCalledOnce(); expect(stopB).not.toHaveBeenCalled();
    expect(a.lifetime.signal.aborted).toBe(true); expect(b.lifetime.signal.aborted).toBe(false);
    b.lifetime.assertLive(); expect(f.cache.readiness("claude", "qualified-model").state).toBe("ready");
  });
  it("owns a child launched asynchronously before Stop until exact exit proof completes", async () => {
    const f = await fixture(), { lifetime, credential } = f.create(), spawned = deferred<{ stopAndProve(): Promise<void> }>(), stopped = deferred<void>();
    const stop = vi.fn(() => stopped.promise);
    const launching = lifetime.launch(() => spawned.promise); await Promise.resolve();
    const closing = lifetime.close(); let closed = false; void closing.then(() => { closed = true; });
    spawned.resolve({ stopAndProve: stop }); await expect(launching).rejects.toThrow();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce()); expect(closed).toBe(false); expect(credential.signal.aborted).toBe(false);
    stopped.resolve(); await closing; expect(credential.signal.aborted).toBe(true); expect(() => credential.assertLive()).toThrow();
  });
  it("takes ownership of late direct attachments after retirement and proves them again", async () => {
    const f = await fixture(), { lifetime } = f.create(); await lifetime.close();
    const stop = vi.fn(async () => {});
    expect(() => lifetime.attach({ stopAndProve: stop })).toThrow(); await lifetime.close();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("does not settle an initially empty retirement before a synchronous late attachment proves exit", async () => {
    const f = await fixture(), { lifetime, credential } = f.create(), stopped = deferred<void>();
    const stop = vi.fn(() => stopped.promise);
    const closing = lifetime.close(); let closed = false; void closing.then(() => { closed = true; });
    expect(() => lifetime.attach({ stopAndProve: stop })).toThrow();
    try {
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      expect(closed).toBe(false); expect(credential.signal.aborted).toBe(false);
    } finally { stopped.resolve(); await closing; }
    expect(closed).toBe(true); expect(credential.signal.aborted).toBe(true);
  });
  it("retains failed proof ownership and escalates quarantine after bounded attempts", async () => {
    const f = await fixture(), { lifetime, credential } = f.create();
    const stop = vi.fn<() => Promise<void>>(async () => { throw new Error("synthetic failed proof"); });
    lifetime.attach({ stopAndProve: stop });
    for (let i = 0; i < 3; i++) await expect(lifetime.close()).rejects.toMatchObject({ code: "cloud_containment_attestation_failed" });
    expect(f.supervisor.onRetirementFailure).toHaveBeenCalledOnce(); expect(credential.signal.aborted).toBe(false);
    stop.mockResolvedValue(undefined); await lifetime.close(); expect(credential.signal.aborted).toBe(true);
  });
  it("counts each failed late-attachment proof once before escalating quarantine", async () => {
    const f = await fixture(), { lifetime, credential } = f.create();
    const stop = vi.fn<() => Promise<void>>(async () => { throw new Error("synthetic failed late proof"); });
    const closing = lifetime.close();
    expect(() => lifetime.attach({ stopAndProve: stop })).toThrow();
    try {
      await expect(closing).rejects.toMatchObject({ code: "cloud_containment_attestation_failed" });
      expect(stop).toHaveBeenCalledTimes(1); expect(f.supervisor.onRetirementFailure).not.toHaveBeenCalled();
      await expect(lifetime.close()).rejects.toMatchObject({ code: "cloud_containment_attestation_failed" });
      expect(stop).toHaveBeenCalledTimes(2); expect(f.supervisor.onRetirementFailure).not.toHaveBeenCalled();
      await expect(lifetime.close()).rejects.toMatchObject({ code: "cloud_containment_attestation_failed" });
      expect(stop).toHaveBeenCalledTimes(3); expect(f.supervisor.onRetirementFailure).toHaveBeenCalledOnce();
      expect(credential.signal.aborted).toBe(false);
    } finally { stop.mockResolvedValue(undefined); await lifetime.close(); }
  });
  it("revoked actor authority retires attached native ownership even when no next Send occurs", async () => {
    const f = await fixture(), { lifetime } = f.create(), stop = vi.fn(async () => {});
    lifetime.attach({ stopAndProve: stop }); f.registry.revoke(f.actor.provenance.actorSessionId); await lifetime.close();
    expect(lifetime.signal.aborted).toBe(true); expect(stop).toHaveBeenCalledOnce();
    expect(() => lifetime.assertLive()).toThrow(expect.objectContaining({ code: "cloud_validation_access_denied" }));
  });
  it("cannot extend expired actor confirmation or engine authority merely because a cache is ready", async () => {
    const f = await fixture(), { lifetime } = f.create(); f.advance(10_001);
    expect(() => lifetime.assertLive()).toThrow(expect.objectContaining({ code: "cloud_validation_session_expired" })); await lifetime.close();
    const g = await fixture(), second = g.create(); g.loseAuthority();
    expect(() => second.lifetime.assertLive()).toThrow(expect.objectContaining({ code: "cloud_validation_lifecycle_superseded" }));
  });
  it("deduplicates proof for repeated close and retires short-lived children without losing session reuse", async () => {
    const f = await fixture(), { lifetime } = f.create(), child = { stopAndProve: vi.fn(async () => {}) };
    lifetime.attach(child); await lifetime.retire(child); expect(child.stopAndProve).toHaveBeenCalledOnce();
    lifetime.assertLive(); await Promise.all([lifetime.close(), lifetime.close()]); expect(child.stopAndProve).toHaveBeenCalledOnce();
  });
});
