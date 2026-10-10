import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CloudAgentBootCredentialResponse, CloudAgentBootProviderReady, CloudAgentWarmActorRequest, CloudAgentWarmActorResponse } from "@zeros/protocol/cloud-agent-bootstrap";
import type { PreparedBoundary } from "../containment/types";
import { CloudActorAuthorityRegistry } from "../cloud-actor-authority";
import { CloudAgentCredentialCache } from "../cloud-agent-credential-cache";
import * as executionModule from "../cloud-provider-execution";
import { readCloudRepositoryMcp } from "../cloud-mcp";
import { isCloudNativeHome } from "../containment/cloud-native-home";
import type { CloudNativeHome } from "../containment/cloud-native-home";
import { cloudNativeProviderEnvironment } from "../containment/cloud-native-boundary";
import { prepareClaudeCloudWorkload } from "../adapters/claude-sdk/__tests__/helpers/legacy-execution";

const native = vi.hoisted(() => ({ prepareBoot: vi.fn(), tools: vi.fn() }));
vi.mock("../containment/cloud-native-boundary", async original => ({ ...await original<typeof import("../containment/cloud-native-boundary")>(), CloudNativeBoundary: { prepare: vi.fn(), prepareBoot: native.prepareBoot } }));
vi.mock("../cloud-workload-tools", () => ({ CloudWorkloadTools: class {
  constructor(...args: unknown[]) { native.tools(...args); }
  async call() { return { ok: true, data: null }; }
  async stopAndProve() {}
} }));
vi.mock("../cloud-mcp", async original => ({ ...await original<typeof import("../cloud-mcp")>(), readCloudRepositoryMcp: vi.fn(async () => []) }));
vi.mock("../containment/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../containment/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("./helpers/test-cloud-runtime")).testCloudRuntime,
}));

const capabilities = { version: 1 as const, goals: false, nativeFork: false, transcriptFork: false,
  nativeReview: false, connectedApps: false, multiAgent: false };
const cleanups: (() => void | Promise<void>)[] = [];
let dataRoot: string;
const nativeHomes = new WeakMap<PreparedBoundary, CloudNativeHome>();
beforeEach(async () => {
  dataRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-boot-factory-consumer-")));
  vi.stubEnv("ZEROS_DATA_DIR", dataRoot);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(dataRoot, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.clearAllMocks(); vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function workload(executionId: string = randomUUID(), conversationId = "conversation"): Promise<PreparedBoundary> {
  const physical = await prepareClaudeCloudWorkload({ executionId, conversationId, provider: "claude", cwd: "/srv/zeros/workspace", dataRoot });
  cleanups.push(physical.dispose);
  nativeHomes.set(physical.workload, physical.nativeHome);
  return physical.workload;
}
async function fixture(initialize = true) {
  let live = true, wall = 1_791_468_000_000, monotonic = 1000;
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 7,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2 };
  const time = { wall: () => wall, monotonic: () => monotonic }, engineLive = () => live;
  const registry = new CloudActorAuthorityRegistry({ scope, time, engineLive }); cleanups.push(() => registry.dispose());
  const provenance = { scope, actorSessionId: randomUUID(), authorityEpoch: 3, confirmedUntilMs: wall + 8000,
    fundingConsentVersion: 1 as const, fundingGrant: { kind: "owner" as const },
    actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 2,
      role: "owner" as const, fingerprint: "a".repeat(64) } };
  const actor = registry.confirm(provenance);
  const provider: CloudAgentBootProviderReady = { status: "ready", provider: "claude", credentialId: randomUUID(),
    credentialRevision: 2, connectionRevision: 3, adoptionId: randomUUID(), displayName: "Test account", kind: "claude-api-key",
    models: ["qualified-model"], nativeCapabilities: capabilities, materialVersion: 1, expiresAt: null, refreshAfter: null,
    authorityExpiresAt: null, material: { kind: "claude-api-key", apiKey: "synthetic-private-provider-A" } };
  const response: CloudAgentBootCredentialResponse = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
    authorityEpoch: 3, cacheRevision: 1, desiredCacheRevision: 1,
    initialAdoptions: [{ provider: "claude", status: "known", adoptionId: provider.adoptionId },
      { provider: "cursor", status: "missing" }, { provider: "codex", status: "missing" }],
    providers: [provider, { status: "unavailable", provider: "cursor", code: "cloud_agent_credential_required" },
      { status: "unavailable", provider: "codex", code: "cloud_agent_credential_required" }] };
  const request = { bootstrap: vi.fn(async (): Promise<unknown> => response), sync: vi.fn(async (): Promise<unknown> => response) };
  const credentials = new CloudAgentCredentialCache({ scope, time, engineLive, request }); cleanups.push(() => credentials.dispose());
  if (initialize) await credentials.initialize();
  const history = { owner: "c".repeat(64), currentKeyVersion: 1, keys: { 1: "a".repeat(43) } };
  const contextRequest = vi.fn(async (input: CloudAgentWarmActorRequest): Promise<unknown> => ({
    ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", authorityEpoch: 3,
    contextId: randomUUID(), contextRevision: "b".repeat(64), actor: provenance,
    provider: input.provider, model: input.model, conversationId: input.conversationId, cwd: input.cwd,
    customization: null, nativeCapabilities: capabilities, gitAuthor: { name: "Sending member", email: "1234+sending-member@users.noreply.github.com" },
    environment: { version: 1, revision: "d".repeat(64), values: { ACTOR_PRIVATE: "synthetic-sender-only-value" }, history },
  } satisfies CloudAgentWarmActorResponse));
  const contexts = new executionModule.CloudAgentContextCache({ scope, registry, time, engineLive,
    isAdmittedCwd: cwd => cwd === "/srv/zeros/workspace", request: contextRequest }); cleanups.push(() => contexts.dispose());
  const base = { actor, provider: "claude" as const, conversationId: "conversation", model: "qualified-model", cwd: "/srv/zeros/workspace" };
  const context = await contexts.warm(base);
  const input = { ...base, context, executionId: randomUUID() };
  const canStart = vi.fn(() => true), supervisor = { onRetirementFailure: vi.fn() };
  const legacy = { prepare: vi.fn(async () => { throw new Error("Legacy was not selected"); }) };
  const options = { legacy, credentials, contexts, registry, engineLive, canStart, supervisor, maxScopes: 32 };
  const create = () => executionModule.createCloudBootAgentExecutionFactory(options);
  native.prepareBoot.mockImplementation(async (authority: executionModule.CloudBootNativeAuthority, domain: PreparedBoundary) => {
    authority.lifetime.assertLive();
    const nativeHome = nativeHomes.get(domain);
    if (!nativeHome) throw new Error("Expected original physical fixture HOME");
    const material = authority.takeMaterial();
    const coordinator = { ...domain, nativeHome, providerHomePath: nativeHome.paths.home,
      environment: () => cloudNativeProviderEnvironment(material,authority.model,undefined,authority.environment?.values,nativeHome),
      codexExternalAuth: () => null, hasBackgroundServers: async () => false };
    authority.lifetime.attach(coordinator); return coordinator;
  });
  const register = (factory: ReturnType<typeof create>) => { cleanups.push(() => factory.disposeBoot()); return factory; };
  const prepare = async (factory: ReturnType<typeof create>, selection = factory.selectBoot(input)) => {
    const domain = await workload(selection.executionId, selection.conversationId);
    await factory.launchBootSelection(selection, async () => domain);
    const result = await factory.prepareBoot({ selection, workload: domain, signal: new AbortController().signal });
    const execution = executionModule.cloudProviderExecution(result.boundary)!;
    return { selection, domain, result, execution };
  };
  const publish = async (revision: number, entry: CloudAgentBootProviderReady = provider) => {
    credentials.markDesired(revision);
    request.sync.mockResolvedValueOnce({ ...response, cacheRevision: revision, desiredCacheRevision: revision,
      providers: response.providers.map(value => value.provider === "claude" ? entry : value) });
    await credentials.synchronize();
  };
  return { scope, registry, actor, provenance, credentials, contexts, provider, response, request, contextRequest, input,
    options, create, register, prepare, publish, canStart, legacy, supervisor,
    loseEngine: () => { live = false; }, advance: (ms: number) => { wall += ms; monotonic += ms; } };
}

describe("genuine boot execution factory", () => {
  it("shares one original physical HOME between the native provider and workload tools", async () => {
    const f = await fixture(), factory = f.register(f.create()), prepared = await f.prepare(factory);
    const home = prepared.execution.coordinator.nativeHome;
    expect(isCloudNativeHome(home)).toBe(true);
    expect(native.tools).toHaveBeenCalledWith(executionModule.cloudBootNativeAuthority(prepared.selection),
      prepared.domain, f.input.cwd, home);
    expect(prepared.result.env).toMatchObject({ ...home.environment(), ACTOR_PRIVATE: "synthetic-sender-only-value" });
    expect(prepared.result.boundary.providerHomePath).toBe(home.paths.home);
    expect(prepared.domain.status.designProtection.enforced).toBe(false);
  });
  it("chooses warm native identity from exact cached authority before a claim without minting another selection", async () => {
    const f = await fixture(), factory = f.register(f.create()), p = await f.prepare(factory);
    const token = factory.reserveBootTurn(p.execution, p.selection);
    expect(factory.canRetainBootExecution({ ...f.input, executionId: p.selection.executionId })).toBe(false);
    factory.markNativeHandoff(p.execution, token); await factory.settleBootTurn(p.execution, token);
    f.request.sync.mockClear(); f.contextRequest.mockClear();
    expect(factory.canRetainBootExecution({ ...f.input, executionId: p.selection.executionId })).toBe(true);
    expect(factory.bootScopeActivity([]).idleHosts).toBe(1);
    expect(f.request.sync).not.toHaveBeenCalled(); expect(f.contextRequest).not.toHaveBeenCalled();
    // The pure probe did not consume the single-use turn selection.
    const next = factory.selectBoot({ ...f.input, executionId: p.selection.executionId });
    expect(factory.reserveBootTurn(p.execution, next)).not.toBe(token);
  });
  it("does not reuse a native identity for foreign actor/context/model/cwd authority", async () => {
    const f = await fixture(), factory = f.register(f.create()), p = await f.prepare(factory);
    const token = factory.reserveBootTurn(p.execution, p.selection);
    factory.markNativeHandoff(p.execution, token); await factory.settleBootTurn(p.execution, token);
    for (const input of [{ ...f.input, actor: { ...f.actor } }, { ...f.input, context: { ...f.input.context } },
      { ...f.input, model: "another-model" }, { ...f.input, cwd: "/srv/zeros/workspace/other" },
      { ...f.input, conversationId: "another-conversation" }])
      expect(factory.canRetainBootExecution({ ...input, executionId: p.selection.executionId })).toBe(false);
  });
  it("does not choose warm native identity across dirty, paused or replaced credential selection", async () => {
    const f = await fixture(), factory = f.register(f.create()), p = await f.prepare(factory);
    const token = factory.reserveBootTurn(p.execution, p.selection);
    factory.markNativeHandoff(p.execution, token); await factory.settleBootTurn(p.execution, token);
    const input = { ...f.input, executionId: p.selection.executionId };
    f.canStart.mockReturnValue(false); expect(factory.canRetainBootExecution(input)).toBe(false);
    f.canStart.mockReturnValue(true); f.credentials.markDesired(2);
    expect(factory.canRetainBootExecution(input)).toBe(false);
    await f.publish(2, { ...f.provider, adoptionId: randomUUID(), material: { kind: "claude-api-key", apiKey: "synthetic-provider-B" } });
    expect(factory.canRetainBootExecution(input)).toBe(false);
  });
  it("keeps warm identity across same-source token material rotation and refuses it after exact retirement", async () => {
    const f = await fixture(), factory = f.register(f.create()), p = await f.prepare(factory);
    const token = factory.reserveBootTurn(p.execution, p.selection);
    factory.markNativeHandoff(p.execution, token); await factory.settleBootTurn(p.execution, token);
    const input = { ...f.input, executionId: p.selection.executionId };
    await f.publish(2, { ...f.provider, materialVersion: 2 });
    expect(factory.canRetainBootExecution(input)).toBe(true);
    await executionModule.cloudExecutionLifetime(p.execution).close();
    expect(factory.canRetainBootExecution(input)).toBe(false);
  });
  it("advertises only a fully constructed positive boot, preserving prepare-only legacy identity", async () => {
    const f = await fixture();
    expect(executionModule.isCloudBootAgentExecutionFactory(f.legacy)).toBe(false);
    const factory = f.register(f.create());
    expect(executionModule.isCloudBootAgentExecutionFactory(factory)).toBe(true);
    expect(executionModule.isCloudBootAgentExecutionFactory({ ...factory })).toBe(false);
    const pending = await fixture(false);
    expect(() => pending.create()).toThrow(expect.objectContaining({ code: "cloud_agent_credential_refresh_required" }));
    for (const field of ["credentials", "contexts", "registry"] as const)
      expect(() => executionModule.createCloudBootAgentExecutionFactory({ ...f.options, [field]: { ...f.options[field] } })).toThrow();
  });
  it("refuses a genuine context helper attached to another registry on the same boot", async () => {
    const f = await fixture();
    const registry = new CloudActorAuthorityRegistry({ scope: f.scope, engineLive: () => true });
    cleanups.push(() => registry.dispose());
    expect(() => executionModule.createCloudBootAgentExecutionFactory({ ...f.options, registry }))
      .toThrow(expect.objectContaining({ code: "cloud_validation_authority_response_invalid" }));
  });
  it("refuses a registry-shaped object before advertising a context cache", async () => {
    const f = await fixture();
    expect(() => new executionModule.CloudAgentContextCache({ scope: f.scope, registry: { ...f.registry } as CloudActorAuthorityRegistry,
      engineLive: () => true, isAdmittedCwd: () => true, request: f.contextRequest }))
      .toThrow(expect.objectContaining({ code: "cloud_validation_authority_response_invalid" }));
  });
  it("mints an original frozen selection locally without CP, repository reads or legacy lease", async () => {
    const f = await fixture(), factory = f.register(f.create());
    f.request.bootstrap.mockClear(); f.request.sync.mockClear(); f.contextRequest.mockClear(); vi.mocked(readCloudRepositoryMcp).mockClear();
    expect(factory.bootDispatchReadiness(f.input).state).toBe("ready");
    const selected = factory.selectBoot(f.input);
    expect(executionModule.isCloudBootAgentSelection(selected)).toBe(true);
    expect(executionModule.isCloudBootAgentSelection({ ...selected })).toBe(false);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(selected).toMatchObject({ mode: "boot-owner-v1", scope: f.scope, actor: f.actor, context: f.input.context,
      provider: "claude", model: f.input.model, executionId: f.input.executionId, cacheRevision: 1,
      credentialRun: { credentialId: f.provider.credentialId, cacheRevision: 1 } });
    expect(selected).not.toHaveProperty("lease"); expect(selected).not.toHaveProperty("delegationId");
    expect(JSON.stringify(selected)).not.toContain("synthetic-private-provider-A");
    expect(f.request.bootstrap).not.toHaveBeenCalled(); expect(f.request.sync).not.toHaveBeenCalled();
    expect(f.contextRequest).not.toHaveBeenCalled(); expect(readCloudRepositoryMcp).not.toHaveBeenCalled();
  });
  it.each(["provider", "model", "cwd", "conversationId", "executionId", "cacheRevision", "actor"] as const)(
    "validates the original same-factory selection and refuses a changed expected %s", async field => {
      const f = await fixture(), factory = f.register(f.create()), selected = factory.selectBoot(f.input);
      const expected = { ...f.input, cacheRevision: 1 };
      expect(factory.validateBootSelection(selected, expected)).toBe(selected);
      expect(() => factory.validateBootSelection({ ...selected }, expected)).toThrow();
      expect(() => factory.validateBootSelection(selected, { ...expected,
        [field]: field === "actor" ? { ...f.actor } : field === "cacheRevision" ? 2 : field === "provider" ? "cursor" : "other" })).toThrow();
      const other = f.register(f.create()); expect(() => other.validateBootSelection(selected, expected)).toThrow();
    });
  it("parks known dirty material and rejects unavailable/foreign actor context without fetching on Send", async () => {
    const f = await fixture(), factory = f.register(f.create()); f.credentials.markDesired(2);
    expect(factory.bootDispatchReadiness(f.input)).toMatchObject({ state: "pending", desiredCacheRevision: 2 });
    expect(() => factory.selectBoot(f.input)).toThrow(expect.objectContaining({ code: "cloud_agent_credential_refresh_required" }));
    expect(() => factory.selectBoot({ ...f.input, actor: { ...f.actor } })).toThrow();
    expect(() => factory.selectBoot({ ...f.input, context: { ...f.input.context } })).toThrow();
    expect(f.request.sync).not.toHaveBeenCalled();
    await f.publish(2);
    expect(factory.bootDispatchReadiness({ ...f.input, provider: "cursor" })).toMatchObject({ state: "unavailable" });
  });
  it("reserves workload ownership before an asynchronous allocation and reaps a late return after Stop", async () => {
    const f = await fixture(), factory = f.register(f.create()), selected = factory.selectBoot(f.input);
    const pending = deferred<PreparedBoundary>(), domain = await workload(selected.executionId), spawn = vi.fn((_signal: AbortSignal) => pending.promise);
    const launched = factory.launchBootSelection(selected, spawn); const outcome = launched.catch(error => error);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const authority = executionModule.cloudBootNativeAuthority(selected);
    const closing = authority.lifetime.close();
    expect(spawn.mock.calls[0]![0].aborted).toBe(true);
    expect(factory.bootScopeActivity([]).reservedLaunches).toBe(1);
    pending.resolve(domain); await closing;
    expect((await outcome).code).toBe("cloud_validation_lifecycle_superseded");
    expect(domain.stopAndProve).toHaveBeenCalled(); expect(factory.bootScopeActivity([]).scopes).toHaveLength(0);
  });
  it("rechecks the start fence in the deferred workload allocation callback", async () => {
    const f = await fixture(), factory = f.register(f.create()), selected = factory.selectBoot(f.input);
    const domain = await workload(selected.executionId), spawn = vi.fn(async () => domain);
    const launched = factory.launchBootSelection(selected, spawn);
    f.canStart.mockReturnValue(false);
    await expect(launched).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(spawn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(factory.bootScopeActivity([]).scopes).toHaveLength(0));
  });
  it("prepares a private native authority from the same reservation, never a fabricated lease", async () => {
    const f = await fixture(), factory = f.register(f.create()), prepared = await f.prepare(factory);
    const authority = executionModule.cloudBootNativeAuthority(prepared.selection);
    expect(executionModule.isCloudBootNativeAuthority(authority)).toBe(true);
    expect(executionModule.isCloudBootNativeAuthority({ ...authority })).toBe(false);
    expect(authority).toMatchObject({ mode: "boot-owner-v1", contextId: f.input.context.contextId, provider: "claude",
      model: f.input.model, environment: { values: { ACTOR_PRIVATE: "synthetic-sender-only-value" } },
      gitAuthor: { name: "Sending member" }, backgroundTasksVersion: null, computerToolsVersion: null });
    expect(authority).not.toHaveProperty("leaseId"); expect(authority).not.toHaveProperty("validate");
    expect(native.prepareBoot).toHaveBeenCalledWith(authority, prepared.domain, f.input.conversationId, undefined);
    expect(native.tools).toHaveBeenCalledWith(authority, prepared.domain, f.input.cwd, prepared.execution.coordinator.nativeHome);
    expect(prepared.execution.mode).toBe("boot-owner-v1");
    expect(executionModule.isCloudBootProviderExecution(prepared.execution)).toBe(true);
    expect(executionModule.isCloudBootProviderExecution({ ...prepared.execution })).toBe(false);
    expect(executionModule.cloudExecutionLifetime(prepared.execution)).toBe(authority.lifetime);
    expect(f.legacy.prepare).not.toHaveBeenCalled();
  });
  it("refuses an arbitrary workload or a copied selection before native preparation", async () => {
    const f = await fixture(), factory = f.register(f.create()), selection = factory.selectBoot(f.input);
    const signal = new AbortController().signal;
    await expect(factory.prepareBoot({ selection, workload: await workload(), signal })).rejects.toThrow();
    await expect(async () => factory.prepareBoot({ selection: { ...selection }, workload: await workload(), signal })).rejects.toThrow();
    expect(native.prepareBoot).not.toHaveBeenCalled();
  });
  it("checks exact current selection and durable starts at handoff, then marks conservatively before write", async () => {
    const f = await fixture(), factory = f.register(f.create()), prepared = await f.prepare(factory);
    const reservation = factory.reserveBootTurn(prepared.execution, prepared.selection);
    expect(executionModule.cloudBootTurnReservation(prepared.execution)).toBe(reservation);
    f.canStart.mockReturnValue(false);
    expect(() => factory.assertNativeHandoff(prepared.execution, reservation)).toThrow();
    f.canStart.mockReturnValue(true);
    factory.assertNativeHandoff(prepared.execution, reservation); factory.markNativeHandoff(prepared.execution, reservation);
    expect(factory.bootScopeActivity([])).toMatchObject({ foreground: 1, reservedLaunches: 0 });
    expect(() => factory.markNativeHandoff(prepared.execution, reservation)).toThrow();
    expect(() => factory.assertNativeHandoff(prepared.execution, { ...reservation })).toThrow();
    // A subsequent transport error cannot reclassify the run as unsubmitted.
    expect(factory.bootScopeActivity([]).foreground).toBe(1);
    await factory.settleBootTurn(prepared.execution, reservation);
    expect(factory.bootScopeActivity([])).toMatchObject({ foreground: 0, idleHosts: 1 });
    expect(prepared.domain.stopAndProve).not.toHaveBeenCalled();
  });
  it("never submits reserved A after B publishes, while entered A descendants retain captured authority", async () => {
    const f = await fixture(), factory = f.register(f.create()), prepared = await f.prepare(factory);
    const reservation = factory.reserveBootTurn(prepared.execution, prepared.selection);
    await f.publish(2, { ...f.provider, material: { kind: "claude-api-key", apiKey: "synthetic-private-provider-B" } });
    expect(() => factory.assertNativeHandoff(prepared.execution, reservation)).toThrow(expect.objectContaining({ code: "cloud_validation_lifecycle_superseded" }));
    executionModule.cloudExecutionLifetime(prepared.execution).assertLive();
    expect(prepared.domain.stopAndProve).not.toHaveBeenCalled();
    const next = factory.selectBoot({ ...f.input, executionId: randomUUID() });
    expect(factory.canReuseBootExecution(prepared.execution, next)).toBe(false);
  });
  it("reuses only the exact conversation/actor/context/provider/model/auth scope and original turn reservation", async () => {
    const f = await fixture(), factory = f.register(f.create()), prepared = await f.prepare(factory);
    const first = factory.reserveBootTurn(prepared.execution, prepared.selection); factory.markNativeHandoff(prepared.execution, first);
    await factory.settleBootTurn(prepared.execution, first);
    await f.publish(2);
    const next = factory.selectBoot(f.input);
    expect(factory.canReuseBootExecution(prepared.execution, next)).toBe(true);
    const reservation = factory.reserveBootTurn(prepared.execution, next);
    expect(reservation).not.toBe(first);
    expect(() => factory.assertNativeHandoff(prepared.execution, first)).toThrow();
    factory.markNativeHandoff(prepared.execution, reservation); await factory.settleBootTurn(prepared.execution, reservation);
    expect(native.prepareBoot).toHaveBeenCalledOnce(); expect(prepared.domain.stopAndProve).not.toHaveBeenCalled();
    expect(factory.bootScopeActivity([]).scopes).toHaveLength(1);
    const siblingInput = { ...f.input, conversationId: "sibling", executionId: randomUUID() };
    const siblingContext = await f.contexts.warm(siblingInput);
    const sibling = factory.selectBoot({ ...siblingInput, context: siblingContext });
    expect(factory.canReuseBootExecution(prepared.execution, sibling)).toBe(false);
  });
  it("an original dispatch selection can reserve only one turn on its live native scope", async () => {
    const f = await fixture(), factory = f.register(f.create()), prepared = await f.prepare(factory);
    const first = factory.reserveBootTurn(prepared.execution, prepared.selection); factory.markNativeHandoff(prepared.execution, first);
    await factory.settleBootTurn(prepared.execution, first);
    expect(() => factory.reserveBootTurn(prepared.execution, prepared.selection)).toThrow();
    const next = factory.selectBoot(f.input);
    expect(next).not.toBe(prepared.selection); expect(next.executionId).toBe(prepared.selection.executionId);
    expect(() => factory.launchBootSelection(next, async () => workload())).toThrow();
    expect(factory.canReuseBootExecution(prepared.execution, next)).toBe(true);
  });
  it("retired execution IDs never reactivate after positive whole-session Stop", async () => {
    const f = await fixture(), factory = f.register(f.create()), prepared = await f.prepare(factory);
    await prepared.result.boundary.stopAndProve();
    expect(() => factory.selectBoot(f.input)).toThrow(expect.objectContaining({ code: "cloud_validation_lifecycle_superseded" }));
    expect(() => factory.selectBoot({ ...f.input, executionId: randomUUID() })).not.toThrow();
  });
  it("a shorter selected turn authority retires its reused host and descendants when it expires, keeping siblings live", async () => {
    vi.useFakeTimers();
    const f = await fixture(), factory = f.register(f.create()), prepared = await f.prepare(factory);
    const first = factory.reserveBootTurn(prepared.execution, prepared.selection); factory.markNativeHandoff(prepared.execution, first);
    await factory.settleBootTurn(prepared.execution, first);
    const siblingInput = { ...f.input, conversationId: "sibling", executionId: randomUUID() };
    const context = await f.contexts.warm(siblingInput);
    const sibling = await f.prepare(factory, factory.selectBoot({ ...siblingInput, context }));
    await f.publish(2, { ...f.provider, authorityExpiresAt: new Date(1_791_468_001_000).toISOString() });
    const next = factory.selectBoot(f.input);
    expect(factory.canReuseBootExecution(prepared.execution, next)).toBe(true);
    const turn = factory.reserveBootTurn(prepared.execution, next); factory.markNativeHandoff(prepared.execution, turn);
    f.advance(1001); await vi.advanceTimersByTimeAsync(1001);
    await vi.waitFor(() => expect(prepared.domain.stopAndProve).toHaveBeenCalled());
    expect(() => executionModule.cloudExecutionLifetime(prepared.execution).assertLive()).toThrow();
    expect(executionModule.cloudExecutionLifetime(prepared.execution).signal.reason).toMatchObject({ code: "cloud_agent_credential_expired" });
    expect(sibling.domain.stopAndProve).not.toHaveBeenCalled();
    executionModule.cloudExecutionLifetime(sibling.execution).assertLive();
  });
  it("surviving background descendants retain the selected warm authority and run provenance until retirement", async () => {
    vi.useFakeTimers();
    const f = await fixture(), factory = f.register(f.create()), prepared = await f.prepare(factory);
    const first = factory.reserveBootTurn(prepared.execution, prepared.selection); factory.markNativeHandoff(prepared.execution, first);
    await factory.settleBootTurn(prepared.execution, first);
    await f.publish(2, { ...f.provider, authorityExpiresAt: new Date(1_791_468_001_000).toISOString() });
    const next = factory.selectBoot(f.input), turn = factory.reserveBootTurn(prepared.execution, next);
    factory.markNativeHandoff(prepared.execution, turn);
    vi.spyOn(prepared.execution.coordinator, "hasBackgroundServers").mockResolvedValue(true);
    await factory.settleBootTurn(prepared.execution, turn);
    executionModule.cloudBootNativeAuthority(next).lifetime.assertLive();
    expect(factory.bootScopeActivity([])).toMatchObject({ background: 1, scopes: [
      { phase: "background", credentialRun: { cacheRevision: 2, credentialId: f.provider.credentialId } },
    ] });
    f.advance(1001); await vi.advanceTimersByTimeAsync(1001);
    await vi.waitFor(() => expect(prepared.domain.stopAndProve).toHaveBeenCalled());
    expect(executionModule.cloudExecutionLifetime(prepared.execution).signal.reason).toMatchObject({ code: "cloud_agent_credential_expired" });
    await vi.waitFor(() => expect(factory.bootScopeActivity([]).scopes).toHaveLength(0));
  });
  it("whole-session Stop proves this host only and leaves sibling authority and boot cache live", async () => {
    const f = await fixture(), factory = f.register(f.create()), first = await f.prepare(factory);
    const siblingInput = { ...f.input, conversationId: "sibling", executionId: randomUUID() };
    const context = await f.contexts.warm(siblingInput);
    const second = await f.prepare(factory, factory.selectBoot({ ...siblingInput, context }));
    await first.result.boundary.stopAndProve();
    expect(first.domain.stopAndProve).toHaveBeenCalled(); expect(second.domain.stopAndProve).not.toHaveBeenCalled();
    executionModule.cloudExecutionLifetime(second.execution).assertLive();
    expect(f.credentials.readiness("claude", "qualified-model").state).toBe("ready");
  });
  it("credential removal invalidates new starts immediately and retains exact inventory through failed proof", async () => {
    const f = await fixture(), factory = f.register(f.create()), prepared = await f.prepare(factory);
    const stop = vi.mocked(prepared.domain.stopAndProve);
    stop.mockRejectedValueOnce(new Error("private unproved retirement"));
    const retiring = factory.retireBootCredentials([{ provider: "claude", credentialId: f.provider.credentialId }]);
    expect(() => factory.selectBoot(f.input)).toThrow(expect.objectContaining({ code: "cloud_agent_credential_revoked" }));
    await expect(retiring).rejects.toThrow();
    expect(factory.bootScopeActivity([{ provider: "claude", credentialId: f.provider.credentialId }]).scopes).toHaveLength(1);
    await factory.retireBootCredentials([{ provider: "claude", credentialId: f.provider.credentialId }]);
    expect(factory.bootScopeActivity([{ provider: "claude", credentialId: f.provider.credentialId }]).scopes).toHaveLength(0);
  });
  it("allows only a positively newer association to create a fresh native scope after exact retirement", async () => {
    const f = await fixture(), factory = f.register(f.create()), prepared = await f.prepare(factory);
    const selectors = [{ provider: "claude" as const, credentialId: f.provider.credentialId }];
    await factory.retireBootCredentials(selectors);
    expect(() => executionModule.cloudExecutionLifetime(prepared.execution).assertLive()).toThrow();
    await f.publish(2, { ...f.provider, connectionRevision: f.provider.connectionRevision + 1 });
    expect(() => factory.selectBoot(f.input)).toThrow(); // Retired native IDs never revive.
    const selection = factory.selectBoot({ ...f.input, executionId: randomUUID() });
    const fresh = await f.prepare(factory, selection);
    executionModule.cloudExecutionLifetime(fresh.execution).assertLive();
    expect(fresh.selection.credentialRun).toMatchObject({ credentialId: f.provider.credentialId, cacheRevision: 2, connectionRevision: 4 });
    expect(() => executionModule.cloudExecutionLifetime(prepared.execution).assertLive()).toThrow();
  });
  it("bounds original reservations and refuses unsafe zero activity selectors", async () => {
    const f = await fixture(), factory = f.register(executionModule.createCloudBootAgentExecutionFactory({ ...f.options, maxScopes: 1 }));
    factory.selectBoot(f.input);
    expect(() => factory.selectBoot({ ...f.input, executionId: randomUUID() })).toThrow(expect.objectContaining({ code: "cloud_validation_execution_limit" }));
    expect(factory.bootScopeActivity([{ provider: "claude", credentialId: "invalid" }]).complete).toBe(false);
  });
  it("engine/actor/context retirement fence every native handoff and drain idle hosts", async () => {
    const f = await fixture(), factory = f.register(f.create()), prepared = await f.prepare(factory);
    const reservation = factory.reserveBootTurn(prepared.execution, prepared.selection);
    f.registry.revoke(f.provenance.actorSessionId);
    expect(() => factory.assertNativeHandoff(prepared.execution, reservation)).toThrow();
    await vi.waitFor(() => expect(prepared.domain.stopAndProve).toHaveBeenCalled());
    const g = await fixture(), other = g.register(g.create()), idle = await g.prepare(other);
    g.contexts.revokeContext(g.input.context.contextId);
    await vi.waitFor(() => expect(idle.domain.stopAndProve).toHaveBeenCalled());
  });
});
