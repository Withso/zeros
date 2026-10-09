import { portableCloudWorkloads } from "./helpers/portable-cloud-custody";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CloudExecutionBoundary } from "../cloud-execution-boundary";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudAgentBootCredentialResponse, CloudAgentBootProviderReady, CloudAgentWarmActorResponse } from "@zeros/protocol/cloud-agent-bootstrap";
import type { CloudAgentAccessMaterial } from "@zeros/protocol/cloud-agent-execution";
import { CloudNativeBoundary } from "../cloud-native-boundary";
import { CloudActorAuthorityRegistry } from "../../cloud-actor-authority";
import { CloudAgentCredentialCache } from "../../cloud-agent-credential-cache";
import { CloudAgentContextCache, cloudBootNativeAuthority, cloudProviderExecution, createCloudBootAgentExecutionFactory } from "../../cloud-provider-execution";
import type { PreparedBoundary, BoundarySpawnRequest } from "../types";

const mocks = vi.hoisted(() => ({ mkdir: vi.fn(), release: vi.fn(), rm: vi.fn(), broker: vi.fn(), history: vi.fn(), materialize: vi.fn(), root: "" }));
const configuration = vi.hoisted(() => ({ version: 4 as const, backend: "cloud-worker" as const, profile: "zeros-cloud-worker-v4" as const,
  uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
  toolchain: { node: process.execPath, supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, mkdir: (...args: Parameters<typeof fs.mkdir>) => { mocks.mkdir(...args); return fs.mkdir(...args); },
    rm: (...args: Parameters<typeof fs.rm>) => { mocks.rm(...args); return fs.rm(...args); } };
});
vi.mock("../../../db/paths", async original => ({ ...await original<typeof import("../../../db/paths")>(), zerosDataDir: () => mocks.root }));
vi.mock("../cloud-worker-config", () => ({ loadCloudWorkerConfiguration: () => configuration, isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
vi.mock("../cloud-runtime-root.mjs", async original => ({ ...await original<typeof import("../cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../__tests__/helpers/test-cloud-runtime")).testCloudRuntime }));
vi.mock("../cloud-native-history", () => ({ CLOUD_NATIVE_HISTORY_ROOT: "/fixture/history", acquireCloudNativeHistory: mocks.history }));
vi.mock("../../../git/github-native-broker", () => ({ createNativeGithubBroker: mocks.broker }));
vi.mock("../../cloud-mcp", async original => ({ ...await original<typeof import("../../cloud-mcp")>(), readCloudRepositoryMcp: vi.fn(async () => []) }));
const capabilities = { version: 1 as const, goals: false, nativeFork: false, transcriptFork: false,
  nativeReview: false, connectedApps: false, multiAgent: false };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.clearAllMocks(); mocks.root = ""; });
async function fixture(provider: "claude" | "cursor" | "codex" = "claude", setup = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-boot-native-")); mocks.root = root;
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workloads = portableCloudWorkloads(configuration); cleanups.push(() => workloads.drain(workloads.fence()));
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
    model: "qualified-model", cwd: root, conversationId: "conversation", customization: null,
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
  const domain = await new CloudExecutionBoundary({ configuration, workloads }).prepare({ executionId: selection.executionId,
    actor: "agent-code", cwd: root, workspaceRoot: root, providerId: provider });
  vi.spyOn(domain, "spawn").mockImplementation(async (_request: BoundarySpawnRequest) => process as unknown as Awaited<ReturnType<PreparedBoundary["spawn"]>>);
  vi.spyOn(domain, "stopAndProve");
  await factory.launchBootSelection(selection, async () => domain);
  const authority = cloudBootNativeAuthority(selection);
  mocks.materialize.mockReset(); mocks.materialize.mockResolvedValue(undefined);
  mocks.broker.mockImplementation(async () => ({ env: {}, stopAndProve: vi.fn(async () => {}) }));
  mocks.history.mockImplementation(async (options: { provider: string }) => ({ mount: { provider: options.provider, directory: "/fixture/history/" + options.provider }, release: mocks.release, materialize: mocks.materialize, capture: vi.fn(async () => {}), confirmBinding: vi.fn(async () => {}) }));
  const replaceCredential = async () => {
    credentials.markDesired(2);
    request.sync.mockResolvedValueOnce({ ...response, cacheRevision: 2, desiredCacheRevision: 2,
      providers: response.providers.map(value => value.provider === provider ? { ...ready, adoptionId: randomUUID(),
        credentialId: randomUUID(), material: { kind: `${provider}-api-key`, apiKey: "synthetic-next-provider-key" } } : value) } as CloudAgentBootCredentialResponse);
    await credentials.synchronize();
  };
  return { root, workloads, factory, selection, authority, domain, process, registry, provenance, request, contextRequest, privateContext, canStart, replaceCredential };
}

describe("boot native preparation retains original authority and Host ownership", () => {
  it.each(["claude", "cursor", "codex"] as const)("materializes the selected %s credential and sender context without a CP lease", async provider => {
    const f = await fixture(provider); f.request.bootstrap.mockClear(); f.contextRequest.mockClear();
    const boundary = await CloudNativeBoundary.prepareBoot(f.authority, f.domain, "conversation");
    const env = boundary.environment();
    expect(env).toMatchObject({ HOME: boundary.nativeHome.paths.home, ACTOR_PRIVATE: "synthetic-sender-value",
      GIT_AUTHOR_NAME: "Sending member", GIT_AUTHOR_EMAIL: "1234+sender@users.noreply.github.com" });
    expect(env[provider === "claude" ? "ANTHROPIC_API_KEY" : provider === "cursor" ? "CURSOR_API_KEY" : "OPENAI_API_KEY"]).toBe("synthetic-selected-provider-key");
    expect(mocks.broker).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: "boot-agent", contextId: f.privateContext.contextId } }));
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conversation", provider,
      customization: expect.objectContaining({ authority: f.privateContext.environment.history }) }));
    expect(f.request.bootstrap).not.toHaveBeenCalled(); expect(f.request.sync).not.toHaveBeenCalled(); expect(f.contextRequest).not.toHaveBeenCalled();
    expect(f.domain.spawn).not.toHaveBeenCalled();
    expect(boundary.nativeHome.paths.home.startsWith(f.root + path.sep)).toBe(true);
    expect(boundary.status.designProtection.enforced).toBe(false);
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
  it("refuses a symlinked engine data root before giving the native domain material", async () => {
    const f = await fixture(); const alias = path.join(f.root, "alias"); await symlink(f.root, alias); mocks.root = alias;
    await expect(CloudNativeBoundary.prepareBoot(f.authority, f.domain, "conversation")).rejects.toThrow(/engine-owned/);
    expect(f.domain.spawn).not.toHaveBeenCalled(); expect(mocks.broker).not.toHaveBeenCalled();
  });
  it("preserves a closed history failure and the original workload cleanup owner", async () => {
    const f = await fixture(); mocks.materialize.mockRejectedValueOnce(Object.assign(new Error("synthetic history refusal"), { code: "cloud_validation_access_denied" }));
    await expect(CloudNativeBoundary.prepareBoot(f.authority, f.domain, "conversation"))
      .rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    await f.authority.lifetime.close(); expect(f.domain.stopAndProve).toHaveBeenCalled();
  });
  it("rejects actor revocation during awaited history materialization before native provider launch", async () => {
    const f = await fixture(); mocks.materialize.mockImplementationOnce(async () => f.registry.revoke(f.provenance.actorSessionId));
    await expect(CloudNativeBoundary.prepareBoot(f.authority, f.domain, "conversation"))
      .rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(f.domain.spawn).not.toHaveBeenCalled();
    await f.authority.lifetime.close(); expect(f.domain.stopAndProve).toHaveBeenCalled();
  });
  it.each(["pause", "replacement"] as const)("refuses a new native launch after %s before transport allocation", async reason => {
    const f = await fixture(), boundary = await CloudNativeBoundary.prepareBoot(f.authority, f.domain, "conversation");
    f.domain.wrapSpawn = vi.fn(() => { throw new Error("Unexpected unadmitted transport allocation"); });
    if (reason === "pause") f.canStart.mockReturnValue(false); else await f.replaceCredential();
    expect(() => boundary.wrapSpawn({ command: "synthetic-cli", args: [], cwd: f.root, env: {} }))
      .toThrow(expect.objectContaining({ code: reason === "pause" ? "cloud_validation_access_denied" : "cloud_validation_lifecycle_superseded" }));
    expect(f.domain.wrapSpawn).not.toHaveBeenCalled();
  });
  it("rechecks the start fence in the deferred native spawn callback", async () => {
    const f = await fixture(), boundary = await CloudNativeBoundary.prepareBoot(f.authority, f.domain, "conversation");
    vi.mocked(f.domain.spawn).mockClear();
    const launching = boundary.spawn({ command: "synthetic-cli", args: [], cwd: f.root, env: {} });
    f.canStart.mockReturnValue(false);
    await expect(launching).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(f.domain.spawn).not.toHaveBeenCalled();
  });
  it("checks the ORIGINAL global workload fence before an existing native host accepts a new turn", async () => {
    const f = await fixture();
    const prepared = await f.factory.prepareBoot({ selection: f.selection, workload: f.domain, signal: new AbortController().signal });
    const execution = cloudProviderExecution(prepared.boundary)!;
    const turn = f.factory.reserveBootTurn(execution, f.selection);
    f.workloads.fence();
    expect(() => f.factory.assertNativeHandoff(execution, turn)).toThrow();
    expect(() => f.factory.markNativeHandoff(execution, turn)).toThrow();
  });
  it("keeps already-entered native descendants on their captured source while next-run credentials change", async () => {
    const f = await fixture();
    f.domain.wrapSpawn = vi.fn(request => ({ ...request, stdio: request.stdio ?? "pipe" }));
    f.domain.cancelUnstartedLaunch = vi.fn();
    const prepared = await f.factory.prepareBoot({ selection: f.selection, workload: f.domain, signal: new AbortController().signal });
    const execution = cloudProviderExecution(prepared.boundary)!;
    const turn = f.factory.reserveBootTurn(execution, f.selection);
    f.factory.markNativeHandoff(execution, turn);
    await f.replaceCredential(); f.canStart.mockReturnValue(false);
    const launch = prepared.boundary.wrapSpawn({ command: "synthetic-child", args: [], cwd: f.root, env: {} });
    prepared.boundary.cancelUnstartedLaunch?.(launch);
    expect(f.domain.wrapSpawn).toHaveBeenCalledOnce();
    vi.mocked(f.domain.spawn).mockClear();
    await expect(prepared.boundary.spawn({ command: "synthetic-child", args: [], cwd: f.root, env: {} })).resolves.toBe(f.process);
    expect(f.domain.spawn).toHaveBeenCalledOnce();
  });
});
