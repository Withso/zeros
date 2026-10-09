import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudAgentBootCredentialResponse, CloudAgentBootProviderReady, CloudAgentWarmActorResponse } from "@zeros/protocol/cloud-agent-bootstrap";
import type { CloudAgentAccessMaterial } from "@zeros/protocol/cloud-agent-execution";
import { CloudNativeBoundary } from "../cloud-native-boundary";
import { CloudActorAuthorityRegistry } from "../../cloud-actor-authority";
import { CloudAgentCredentialCache } from "../../cloud-agent-credential-cache";
import { CloudAgentContextCache, cloudBootNativeAuthority, cloudProviderExecution, createCloudBootAgentExecutionFactory } from "../../cloud-provider-execution";
import type { PreparedBoundary, BoundarySpawnRequest } from "../types";

const mocks = vi.hoisted(() => ({ attest: vi.fn(), mkdir: vi.fn(), release: vi.fn(), rm: vi.fn(), broker: vi.fn(), history: vi.fn(), rootMode: 0o700 }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(),
  mkdir: mocks.mkdir, chmod: vi.fn(), writeFile: vi.fn(), chown: vi.fn(), rm: mocks.rm,
  lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: mocks.rootMode }),
  realpath: async () => "/run/zeros/coordinators", readlink: async () => "pid:[synthetic-parent]",
}));
vi.mock("../cloud-worker-config", () => ({ loadCloudWorkerConfiguration: () => ({ version: 4, uid: 10001, gid: 10001,
  toolchain: { node: "/fixture/runtime/bin/node" } }) }));
vi.mock("../cloud-runtime-root.mjs", async original => ({ ...await original<typeof import("../cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../__tests__/helpers/test-cloud-runtime")).testCloudRuntime }));
vi.mock("../cloud-coordinator-attestation", () => ({ attestCloudCoordinator: mocks.attest }));
vi.mock("../cloud-native-history", () => ({ CLOUD_NATIVE_HISTORY_ROOT: "/fixture/history", acquireCloudNativeHistory: mocks.history }));
vi.mock("../../../git/github-native-broker", () => ({ createNativeGithubBroker: mocks.broker }));
vi.mock("../../cloud-mcp", async original => ({ ...await original<typeof import("../../cloud-mcp")>(), readCloudRepositoryMcp: vi.fn(async () => []) }));
const capabilities = { version: 1 as const, goals: false, nativeFork: false, transcriptFork: false,
  nativeReview: false, connectedApps: false, multiAgent: false };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.clearAllMocks(); mocks.rootMode = 0o700; });
async function fixture(provider: "claude" | "cursor" | "codex" = "claude", setup = false) {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 7, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2 };
  const registry = new CloudActorAuthorityRegistry({ scope, engineLive: () => true }); cleanups.push(() => registry.dispose());
  const provenance = { scope, actorSessionId: randomUUID(), authorityEpoch: 3, confirmedUntilMs: Date.now() + 8000,
    fundingConsentVersion: 1 as const, fundingGrant: { kind: "owner" as const },
    actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 2,
      role: "owner" as const, fingerprint: "a".repeat(64) } };
  const actor = registry.confirm(provenance);
  const material: CloudAgentAccessMaterial = setup ? { kind: "claude-setup-token", accessToken: "synthetic-selected-setup-token" } :
    provider === "claude" ? { kind: "claude-api-key", apiKey: "synthetic-selected-provider-key" } :
    provider === "cursor" ? { kind: "cursor-api-key", apiKey: "synthetic-selected-provider-key" } :
    { kind: "codex-api-key", apiKey: "synthetic-selected-provider-key" };
  const ready: CloudAgentBootProviderReady = { status: "ready", provider, kind: material.kind, material,
    credentialId: randomUUID(), credentialRevision: 2, connectionRevision: 3, adoptionId: randomUUID(), displayName: "Test account",
    models: ["qualified-model"], nativeCapabilities: capabilities, materialVersion: 1, expiresAt: null, refreshAfter: null, authorityExpiresAt: null };
  const response: CloudAgentBootCredentialResponse = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
    authorityEpoch: 3, cacheRevision: 1, desiredCacheRevision: 1,
    initialAdoptions: ["claude", "cursor", "codex"].map(value => value === provider ? { provider: value, status: "known", adoptionId: ready.adoptionId } :
      { provider: value as "claude" | "cursor" | "codex", status: "missing" }),
    providers: ["claude", "cursor", "codex"].map(value => value === provider ? ready :
      { status: "unavailable", provider: value as "claude" | "cursor" | "codex", code: "cloud_agent_credential_required" }) };
  const request = { bootstrap: vi.fn(async () => response), sync: vi.fn(async () => response) };
  const credentials = new CloudAgentCredentialCache({ scope, engineLive: () => true, request }); cleanups.push(() => credentials.dispose());
  await credentials.initialize();
  const history = { owner: "c".repeat(64), currentKeyVersion: 1, keys: { 1: "a".repeat(43) } };
  const privateContext: CloudAgentWarmActorResponse = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
    authorityEpoch: 3, contextId: randomUUID(), contextRevision: "b".repeat(64), actor: provenance, provider,
    model: "qualified-model", cwd: "/srv/zeros/workspace", conversationId: "conversation", customization: null,
    nativeCapabilities: capabilities, gitAuthor: { name: "Sending member", email: "1234+sender@users.noreply.github.com" },
    environment: { version: 1, revision: "d".repeat(64), values: { ACTOR_PRIVATE: "synthetic-sender-value" }, history } };
  const contextRequest = vi.fn(async () => privateContext);
  const contexts = new CloudAgentContextCache({ scope, registry, engineLive: () => true, isAdmittedCwd: () => true, request: contextRequest });
  cleanups.push(() => contexts.dispose());
  const input = { actor, provider, model: privateContext.model, cwd: privateContext.cwd, conversationId: privateContext.conversationId };
  const context = await contexts.warm(input);
  const canStart = vi.fn(() => true);
  const factory = createCloudBootAgentExecutionFactory({ registry, contexts, credentials, engineLive: () => true,
    canStart, legacy: { prepare: vi.fn(async () => { throw new Error("Legacy not selected"); }) }, supervisor: { onRetirementFailure: vi.fn() } });
  cleanups.push(() => factory.disposeBoot());
  const selection = factory.selectBoot({ ...input, context, executionId: randomUUID() });
  const process = { stopAndProve: vi.fn(async () => {}), stderr: { resume: vi.fn() }, wait: () => new Promise(() => {}) };
  const domain = { generation: "fixture", status: { version: 1, actor: "agent-code", backend: "cloud-worker", state: "ready",
    designProtection: { required: true, enforced: true, protectedDirectoryCount: 1 }, parity: { level: "restricted", restrictions: [] }, checkedAt: Date.now() },
    attestation: Promise.resolve(), spawn: vi.fn(async (_request: BoundarySpawnRequest) => process), stopAndProve: vi.fn(async () => {}) } as unknown as PreparedBoundary;
  await factory.launchBootSelection(selection, async () => domain);
  const authority = cloudBootNativeAuthority(selection);
  mocks.attest.mockReset(); mocks.attest.mockResolvedValue(undefined);
  mocks.broker.mockImplementation(async () => ({ env: {}, stopAndProve: vi.fn(async () => {}) }));
  mocks.history.mockImplementation(async (options: { provider: string }) => ({ mount: { provider: options.provider, directory: "/fixture/history/" + options.provider }, release: mocks.release }));
  const replaceCredential = async () => {
    credentials.markDesired(2);
    request.sync.mockResolvedValueOnce({ ...response, cacheRevision: 2, desiredCacheRevision: 2,
      providers: response.providers.map(value => value.provider === provider ? { ...ready, adoptionId: randomUUID(),
        credentialId: randomUUID(), material: { kind: `${provider}-api-key`, apiKey: "synthetic-next-provider-key" } } : value) } as CloudAgentBootCredentialResponse);
    await credentials.synchronize();
  };
  return { factory, selection, authority, domain, process, registry, provenance, request, contextRequest, privateContext, canStart, replaceCredential };
}

describe("boot native preparation retains the admitted containment guards", () => {
  it.each(["claude", "cursor", "codex"] as const)("materializes the selected %s credential and sender context without a CP lease", async provider => {
    const f = await fixture(provider); f.request.bootstrap.mockClear(); f.contextRequest.mockClear();
    const boundary = await CloudNativeBoundary.prepareBoot(f.authority, f.domain, "conversation");
    const env = boundary.environment();
    expect(env).toMatchObject({ HOME: "/srv/zeros/home/agent", ACTOR_PRIVATE: "synthetic-sender-value",
      GIT_AUTHOR_NAME: "Sending member", GIT_AUTHOR_EMAIL: "1234+sender@users.noreply.github.com" });
    expect(env[provider === "claude" ? "ANTHROPIC_API_KEY" : provider === "cursor" ? "CURSOR_API_KEY" : "OPENAI_API_KEY"]).toBe("synthetic-selected-provider-key");
    expect(mocks.broker).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: "boot-agent", contextId: f.privateContext.contextId } }));
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conversation", provider,
      customization: expect.objectContaining({ authority: f.privateContext.environment.history }) }));
    expect(mocks.attest).toHaveBeenCalledWith(f.authority.lifetime, f.process, "zeros-native-provider-v1");
    expect(f.request.bootstrap).not.toHaveBeenCalled(); expect(f.request.sync).not.toHaveBeenCalled(); expect(f.contextRequest).not.toHaveBeenCalled();
    expect(f.domain.spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/srv/zeros/workspace",
      cloudNativeHome: expect.objectContaining({ directory: expect.stringMatching(/^\/run\/zeros\/coordinators\/[a-f0-9]{32}$/) }) }));
    expect(Object.values(vi.mocked(f.domain.spawn).mock.calls[0]![0].env)).not.toContain("synthetic-selected-provider-key");
  });
  it("delivers the selected Claude setup token only as the admitted OAuth environment", async () => {
    const f = await fixture("claude", true), boundary = await CloudNativeBoundary.prepareBoot(f.authority, f.domain, "conversation");
    expect(boundary.environment().CLAUDE_CODE_OAUTH_TOKEN).toBe("synthetic-selected-setup-token");
    expect(boundary.environment()).not.toHaveProperty("ANTHROPIC_API_KEY");
  });
  it.each(["copy", "workload", "conversation"] as const)("refuses a foreign %s before filesystem/material/CLI activity", async kind => {
    const f = await fixture(); mocks.mkdir.mockClear();
    await expect(CloudNativeBoundary.prepareBoot(kind === "copy" ? { ...f.authority } : f.authority,
      kind === "workload" ? { ...f.domain } : f.domain, kind === "conversation" ? "other" : "conversation"))
      .rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(mocks.mkdir).not.toHaveBeenCalled(); expect(f.domain.spawn).not.toHaveBeenCalled(); expect(mocks.broker).not.toHaveBeenCalled();
  });
  it("retains engine-owned root mode checks before giving the native domain material", async () => {
    const f = await fixture(); mocks.rootMode = 0o777;
    await expect(CloudNativeBoundary.prepareBoot(f.authority, f.domain, "conversation")).rejects.toThrow(/engine-owned/);
    expect(f.domain.spawn).not.toHaveBeenCalled(); expect(mocks.broker).not.toHaveBeenCalled();
  });
  it("preserves a closed native canary failure and the original workload cleanup owner", async () => {
    const f = await fixture(); mocks.attest.mockRejectedValueOnce(new Error("synthetic canary refusal"));
    await expect(CloudNativeBoundary.prepareBoot(f.authority, f.domain, "conversation"))
      .rejects.toMatchObject({ code: "cloud_containment_canary_failed" });
    await f.authority.lifetime.close(); expect(f.domain.stopAndProve).toHaveBeenCalled();
  });
  it("rejects actor revocation during the real canary stage before native provider launch", async () => {
    const f = await fixture(); mocks.attest.mockImplementationOnce(async () => f.registry.revoke(f.provenance.actorSessionId));
    await expect(CloudNativeBoundary.prepareBoot(f.authority, f.domain, "conversation"))
      .rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(f.domain.spawn).toHaveBeenCalledOnce();
    await f.authority.lifetime.close(); expect(f.domain.stopAndProve).toHaveBeenCalled();
  });
  it.each(["pause", "replacement"] as const)("refuses a new native launch after %s before transport allocation", async reason => {
    const f = await fixture(), boundary = await CloudNativeBoundary.prepareBoot(f.authority, f.domain, "conversation");
    f.domain.wrapSpawn = vi.fn(() => { throw new Error("Unexpected unadmitted transport allocation"); });
    if (reason === "pause") f.canStart.mockReturnValue(false); else await f.replaceCredential();
    expect(() => boundary.wrapSpawn({ command: "synthetic-cli", args: [], cwd: "/srv/zeros/workspace", env: {} }))
      .toThrow(expect.objectContaining({ code: reason === "pause" ? "cloud_validation_access_denied" : "cloud_validation_lifecycle_superseded" }));
    expect(f.domain.wrapSpawn).not.toHaveBeenCalled();
  });
  it("rechecks the start fence in the deferred native spawn callback", async () => {
    const f = await fixture(), boundary = await CloudNativeBoundary.prepareBoot(f.authority, f.domain, "conversation");
    vi.mocked(f.domain.spawn).mockClear();
    const launching = boundary.spawn({ command: "synthetic-cli", args: [], cwd: "/srv/zeros/workspace", env: {} });
    f.canStart.mockReturnValue(false);
    await expect(launching).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(f.domain.spawn).not.toHaveBeenCalled();
  });
  it("keeps already-entered native descendants on their captured source while next-run credentials change", async () => {
    const f = await fixture();
    f.domain.wrapSpawn = vi.fn(request => ({ ...request, stdio: request.stdio ?? "pipe" }));
    const prepared = await f.factory.prepareBoot({ selection: f.selection, workload: f.domain, signal: new AbortController().signal });
    const execution = cloudProviderExecution(prepared.boundary)!;
    const turn = f.factory.reserveBootTurn(execution, f.selection);
    f.factory.markNativeHandoff(execution, turn);
    await f.replaceCredential(); f.canStart.mockReturnValue(false);
    const launch = prepared.boundary.wrapSpawn({ command: "synthetic-child", args: [], cwd: "/srv/zeros/workspace", env: {} });
    prepared.boundary.cancelUnstartedLaunch?.(launch);
    expect(f.domain.wrapSpawn).toHaveBeenCalledOnce();
    vi.mocked(f.domain.spawn).mockClear();
    await expect(prepared.boundary.spawn({ command: "synthetic-child", args: [], cwd: "/srv/zeros/workspace", env: {} })).resolves.toBe(f.process);
    expect(f.domain.spawn).toHaveBeenCalledOnce();
  });
});
