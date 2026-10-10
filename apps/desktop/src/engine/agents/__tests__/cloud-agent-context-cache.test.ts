import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudAgentWarmActorRequest, CloudAgentWarmActorResponse } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudActorAuthorityRegistry } from "../cloud-actor-authority";
import { CloudAgentContextCache, isCloudAuthorizedAgentContext } from "../cloud-provider-execution";
import { cloudMcpDigest, readCloudRepositoryMcp } from "../cloud-mcp";

vi.mock("../cloud-mcp", async original => ({ ...await original<typeof import("../cloud-mcp")>(), readCloudRepositoryMcp: vi.fn(async () => []) }));
const capabilities = { version: 1 as const, goals: false, nativeFork: false, transcriptFork: false,
  nativeReview: false, connectedApps: false, multiAgent: false };
const disposables: { dispose(): void }[] = [];
afterEach(() => { for (const item of disposables.splice(0)) item.dispose(); vi.clearAllMocks(); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture() {
  let wall = 1_791_468_000_000, monotonic = 1000, live = true;
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 7,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(),
    fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2 };
  const time = { wall: () => wall, monotonic: () => monotonic };
  const registry = new CloudActorAuthorityRegistry({ scope, time, engineLive: () => live }); disposables.push(registry);
  const provenance = { scope, actorSessionId: randomUUID(), authorityEpoch: 3, confirmedUntilMs: wall + 8000,
    fundingConsentVersion: 1 as const, fundingGrant: { kind: "owner" as const },
    actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 2,
      role: "owner" as const, fingerprint: "a".repeat(64) } };
  const actor = registry.confirm(provenance);
  const input = { actor, provider: "claude" as const, conversationId: "conversation", model: "qualified-model", cwd: "/srv/zeros/workspace" };
  const history = { owner: "c".repeat(64), currentKeyVersion: 1, keys: { 1: "a".repeat(43) } };
  const response: CloudAgentWarmActorResponse = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
    authorityEpoch: 3, contextId: randomUUID(), contextRevision: "b".repeat(64), actor: provenance,
    provider: input.provider, conversationId: input.conversationId, model: input.model, cwd: input.cwd,
    customization: null, nativeCapabilities: capabilities, gitAuthor: null,
    environment: { version: 1, revision: "d".repeat(64), values: { ACTOR_PRIVATE: "synthetic-sender-private-value" }, history } };
  const request = vi.fn(async (_request: CloudAgentWarmActorRequest, _signal: AbortSignal): Promise<unknown> => response);
  const isAdmittedCwd = vi.fn((cwd: string) => cwd === "/srv/zeros/workspace");
  const options = { scope, registry, request, time, engineLive: () => live, isAdmittedCwd };
  const cache = new CloudAgentContextCache(options); disposables.push(cache);
  return { cache, options, registry, actor, provenance, input, response, request, isAdmittedCwd, scope, time,
    advance: (ms: number) => { wall += ms; monotonic += ms; },
    moveWall: (ms: number) => { wall += ms; }, moveMonotonic: (ms: number) => { monotonic += ms; },
    loseEngine: () => { live = false; }, renewActor: (ms = 8000) => registry.confirm({ ...provenance, confirmedUntilMs: wall + ms }) };
}

describe("private background actor context", () => {
  it("mints an opaque exact context only after the private response, without exporting material", async () => {
    const f = fixture();
    expect(f.cache.readiness(f.input)).toEqual({ state: "pending" });
    const context = await f.cache.warm(f.input);
    expect(isCloudAuthorizedAgentContext(context)).toBe(true);
    expect(isCloudAuthorizedAgentContext({ ...context })).toBe(false);
    expect(context).toMatchObject({ contextId: f.response.contextId, contextRevision: f.response.contextRevision,
      scope: f.scope, actor: f.actor, provider: "claude", model: f.input.model, cwd: f.input.cwd, conversationId: f.input.conversationId });
    expect(Object.isFrozen(context)).toBe(true);
    expect(JSON.stringify(context)).not.toContain("synthetic-sender-private-value");
    expect(JSON.stringify(context)).not.toContain("currentKeyVersion");
    expect(f.cache.authorize(f.input)).toBe(context);
    const { fundingOwnerUserId: _owner, fundingOwnerEpoch: _epoch, ...reference } = f.scope;
    expect(f.request).toHaveBeenCalledWith({ ...reference,
      version: 1, mode: "boot-owner-v1", actorSessionId: f.provenance.actorSessionId, provider: "claude",
      conversationId: f.input.conversationId, model: f.input.model, cwd: f.input.cwd, repositoryServers: [] }, expect.any(AbortSignal));
  });

  it("synchronous readiness/authorization reads never initiate CP or filesystem work", async () => {
    const f = fixture(), context = await f.cache.warm(f.input); f.request.mockClear(); vi.mocked(readCloudRepositoryMcp).mockClear();
    for (let index = 0; index < 3; index++) {
      expect(f.cache.readiness(f.input)).toEqual({ state: "ready", context });
      expect(f.cache.authorize(f.input)).toBe(context); context.assertLive();
    }
    expect(f.request).not.toHaveBeenCalled(); expect(readCloudRepositoryMcp).not.toHaveBeenCalled();
  });

  it("single-flights only the same exact actor/provider/conversation/cwd/model request", async () => {
    const f = fixture(), pending = deferred<unknown>(); f.request.mockImplementation(() => pending.promise);
    const first = f.cache.warm(f.input), second = f.cache.warm(f.input);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    pending.resolve(f.response);
    expect(await first).toBe(await second);
    expect(readCloudRepositoryMcp).toHaveBeenCalledOnce();
  });

  it("a fresh unchanged warm proof renews the same live context identity", async () => {
    const f = fixture(), context = await f.cache.warm(f.input); f.advance(5000);
    f.request.mockResolvedValueOnce({ ...f.response, actor: { ...f.provenance, confirmedUntilMs: f.time.wall() + 8000 } });
    expect(await f.cache.warm(f.input)).toBe(context);
    f.advance(4000); context.assertLive(); expect(f.cache.authorize(f.input)).toBe(context);
  });

  it("actor-only renewal never extends cached MCP/env/Git/history authority", async () => {
    const f = fixture(), context = await f.cache.warm(f.input); f.advance(7000); expect(f.renewActor()).toBe(f.actor);
    f.advance(1500); f.actor.assertLive();
    expect(() => context.assertLive()).toThrow(expect.objectContaining({ code: "cloud_validation_session_expired" }));
    expect(context.signal.aborted).toBe(true);
    expect(f.cache.readiness(f.input)).toEqual({ state: "pending" });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("an expired context cannot revive with a later deadline on the same ID", async () => {
    const f = fixture(), context = await f.cache.warm(f.input); f.advance(7000); f.renewActor(); f.advance(1500);
    f.request.mockResolvedValueOnce({ ...f.response, actor: { ...f.provenance, confirmedUntilMs: f.time.wall() + 8000 } });
    await expect(f.cache.warm(f.input)).rejects.toMatchObject({ code: "cloud_validation_lifecycle_superseded" });
    expect(context.signal.aborted).toBe(true);
    const next = { ...f.response, contextId: randomUUID(), actor: { ...f.provenance, confirmedUntilMs: f.time.wall() + 8000 } };
    f.request.mockResolvedValueOnce(next);
    const replacement = await f.cache.warm(f.input); expect(replacement).not.toBe(context); replacement.assertLive();
  });

  it.each(["wall", "monotonic"] as const)("context expiry independently honors the %s deadline", async clock => {
    const f = fixture(), context = await f.cache.warm(f.input);
    f.advance(7000); f.renewActor();
    if (clock === "wall") f.moveWall(1500); else { f.moveWall(-5000); f.moveMonotonic(1500); }
    expect(() => context.assertLive()).toThrow(); expect(context.signal.aborted).toBe(true);
  });

  it("expiry aborts idle scopes without waiting for another prompt", async () => {
    vi.useFakeTimers(); const f = fixture(), context = await f.cache.warm(f.input);
    f.advance(7000); await vi.advanceTimersByTimeAsync(7000); f.renewActor();
    f.advance(1500); await vi.advanceTimersByTimeAsync(1500);
    expect(context.signal.aborted).toBe(true); expect(f.actor.signal.aborted).toBe(false);
  });

  it.each(["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch"] as const)(
    "rejects a response from another %s", async field => {
      const f = fixture(); f.request.mockResolvedValueOnce({ ...f.response,
        [field]: field === "generation" || field === "fundingOwnerEpoch" ? 9 : randomUUID() });
      await expect(f.cache.warm(f.input)).rejects.toMatchObject({ code: "cloud_admission_authority_response_invalid" });
      expect(f.cache.readiness(f.input)).toEqual({ state: "pending" });
    });

  it.each(["provider", "model", "cwd", "conversationId"] as const)("rejects a response for a foreign %s", async field => {
    const f = fixture(); f.request.mockResolvedValueOnce({ ...f.response,
      [field]: field === "provider" ? "cursor" : field === "cwd" ? "/srv/zeros/workspace/other" : "other" });
    await expect(f.cache.warm(f.input)).rejects.toMatchObject({ code: "cloud_admission_authority_response_invalid" });
  });

  it("refuses actor/session substitutions, viewers and unproved funding", async () => {
    const f = fixture();
    for (const actor of [{ ...f.provenance, actorSessionId: randomUUID() },
      { ...f.provenance, fundingConsentVersion: null, fundingGrant: null },
      { ...f.provenance, actor: { ...f.provenance.actor, role: "viewer" } }]) {
      f.request.mockResolvedValueOnce({ ...f.response, actor });
      await expect(f.cache.warm(f.input)).rejects.toThrow();
    }
  });

  it("newer key/epoch proof retires the original principal and cannot mutate its pending request", async () => {
    const f = fixture(); f.request.mockResolvedValueOnce({ ...f.response, authorityEpoch: 4,
      actor: { ...f.provenance, authorityEpoch: 4, actor: { ...f.provenance.actor, deviceKeyVersion: 3 } } });
    await expect(f.cache.warm(f.input)).rejects.toMatchObject({ code: "cloud_validation_lifecycle_superseded" });
    expect(f.actor.signal.aborted).toBe(true);
    expect(() => f.cache.authorize(f.input)).toThrow();
  });

  it("does not permit a copied actor or genuine principal from another registry", async () => {
    const f = fixture(), other = new CloudActorAuthorityRegistry({ scope: f.scope, time: f.time, engineLive: () => true }); disposables.push(other);
    for (const actor of [{ ...f.actor }, other.confirm(f.provenance)])
      await expect(f.cache.warm({ ...f.input, actor })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("admits only engine-verified checkout roots and refuses noncanonical caller cwd", async () => {
    const f = fixture();
    for (const cwd of ["/etc", "/srv/zeros/workspace/../other", "relative", "/srv/zeros/workspace/."])
      await expect(f.cache.warm({ ...f.input, cwd })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("tolerant accepted repository servers are echoed and digest-verified before context minting", async () => {
    const f = fixture(), server = { name: "0canvas", transport: "http" as const, url: "https://tools.example.test/mcp" };
    vi.mocked(readCloudRepositoryMcp).mockResolvedValue([server]);
    const snapshot = { version: 1 as const, repositoryDigest: "e".repeat(64), history: f.response.environment.history,
      servers: [{ server, scope: "repository" as const, secretRef: null, revision: 0 }], skills: [], cursorTeamSettings: "disabled" as const };
    const customization = { ...snapshot, digest: cloudMcpDigest(snapshot) };
    f.request.mockResolvedValueOnce({ ...f.response, customization });
    expect((await f.cache.warm(f.input)).contextId).toBe(f.response.contextId);
    expect(f.request.mock.calls[0]![0].repositoryServers).toEqual([server]);
    for (const customization of [null, { ...snapshot, digest: "f".repeat(64) }, { ...snapshot, servers: [], digest: cloudMcpDigest(snapshot) }]) {
      f.request.mockResolvedValueOnce({ ...f.response, contextId: randomUUID(), customization });
      await expect(f.cache.warm(f.input)).rejects.toThrow();
    }
    vi.mocked(readCloudRepositoryMcp).mockResolvedValue([]);
  });

  it("changed policy/materialized context on the same ID/revision is rejected and retires the old context", async () => {
    const f = fixture(), context = await f.cache.warm(f.input);
    f.request.mockResolvedValueOnce({ ...f.response, environment: { ...f.response.environment,
      values: { ACTOR_PRIVATE: "synthetic-other-member-value" } } });
    await expect(f.cache.warm(f.input)).rejects.toMatchObject({ code: "cloud_admission_authority_response_invalid" });
    expect(context.signal.aborted).toBe(true);
  });

  it("a newly verified context retires only the previous exact conversation context", async () => {
    const f = fixture(), first = await f.cache.warm(f.input);
    const otherInput = { ...f.input, conversationId: "sibling" };
    f.request.mockResolvedValueOnce({ ...f.response, contextId: randomUUID(), conversationId: "sibling" });
    const sibling = await f.cache.warm(otherInput);
    f.request.mockResolvedValueOnce({ ...f.response, contextId: randomUUID(), contextRevision: "e".repeat(64) });
    const replacement = await f.cache.warm(f.input);
    expect(first.signal.aborted).toBe(true); expect(sibling.signal.aborted).toBe(false);
    expect(f.cache.authorize(f.input)).toBe(replacement); expect(f.cache.authorize(otherInput)).toBe(sibling);
  });

  it("hard actor revocation retires its contexts; ordinary transport closure is not a cache revoke", async () => {
    const f = fixture(), context = await f.cache.warm(f.input);
    f.registry.revoke(f.provenance.actorSessionId);
    expect(context.signal.aborted).toBe(true);
    await expect(f.cache.warm(f.input)).rejects.toThrow();
  });

  it("retains a hard context tombstone against a late positive background callback", async () => {
    const f = fixture(), pending = deferred<unknown>(); f.request.mockImplementation(() => pending.promise);
    const warming = f.cache.warm(f.input); await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    f.cache.revokeContext(f.response.contextId); pending.resolve(f.response);
    await expect(warming).rejects.toThrow(); expect(f.cache.readiness(f.input)).toEqual({ state: "pending" });
  });

  it("engine replacement/disposal cannot install a late context or retain private values", async () => {
    const f = fixture(), pending = deferred<unknown>(); f.request.mockImplementation(() => pending.promise);
    const warming = f.cache.warm(f.input); await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    f.loseEngine(); f.cache.dispose(); pending.resolve(f.response);
    await expect(warming).rejects.toMatchObject({ code: "cloud_validation_lifecycle_superseded" });
  });

  it("bounded live-context capacity refuses extra chats instead of aliasing or evicting their authority", async () => {
    const f = fixture(), cache = new CloudAgentContextCache({ ...f.options, maxContexts: 1 }); disposables.push(cache);
    const context = await cache.warm(f.input);
    f.request.mockResolvedValueOnce({ ...f.response, contextId: randomUUID(), conversationId: "another" });
    await expect(cache.warm({ ...f.input, conversationId: "another" })).rejects.toMatchObject({ code: "cloud_validation_execution_limit" });
    context.assertLive(); expect(cache.authorize(f.input)).toBe(context);
  });

  it("uses only bounded closed authority failure metadata, with no automatic legacy fallback", async () => {
    const f = fixture(); f.request.mockRejectedValueOnce(new Error("synthetic-private-driver-detail"));
    await expect(f.cache.warm(f.input)).rejects.toMatchObject({ code: "cloud_admission_authority_unavailable", message: "Cloud actor context is unavailable" });
    f.request.mockRejectedValueOnce(Object.assign(new Error("synthetic-private-driver-detail"), { code: "cloud_validation_rate_limited" }));
    await expect(f.cache.warm(f.input)).rejects.toMatchObject({ code: "cloud_validation_rate_limited", message: "Cloud actor context is unavailable" });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
});
