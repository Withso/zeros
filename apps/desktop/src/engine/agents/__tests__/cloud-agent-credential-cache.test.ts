import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudAgentBootCredentialResponse, CloudAgentBootProviderReady, CloudAgentBootRefreshResponse } from "@zeros/protocol/cloud-agent-bootstrap";

const capabilities = { version: 1 as const, goals: false, nativeFork: false, transcriptFork: false,
  nativeReview: false, connectedApps: false, multiAgent: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const caches: { dispose(): void }[] = [];
afterEach(() => { for (const cache of caches.splice(0)) cache.dispose(); vi.useRealTimers(); });

async function fixture() {
  const modulePath = "../cloud-agent-credential-cache";
  const { CloudAgentCredentialCache } = await import(modulePath) as typeof import("../cloud-agent-credential-cache");
  let wall = 1_791_468_000_000, monotonic = 1000, live = true;
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 7,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(),
    fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2 };
  const provider: CloudAgentBootProviderReady = { status: "ready", provider: "claude",
    credentialId: randomUUID(), credentialRevision: 2, connectionRevision: 3, adoptionId: randomUUID(), displayName: "Test account",
    kind: "claude-api-key", models: ["qualified-model"], nativeCapabilities: capabilities,
    materialVersion: 1, expiresAt: null, refreshAfter: null, authorityExpiresAt: null,
    material: { kind: "claude-api-key", apiKey: "synthetic-private-provider-A" } };
  const response: CloudAgentBootCredentialResponse = { ...scope, version: 1, mode: "boot-owner-v1",
    fundingScope: "workspace-roles-v1", authorityEpoch: 3, cacheRevision: 1, desiredCacheRevision: 1,
    initialAdoptions: [{ provider: "claude", status: "known", adoptionId: provider.adoptionId },
      { provider: "cursor", status: "missing" }, { provider: "codex", status: "unknown" }],
    providers: [provider, { status: "unavailable", provider: "cursor", code: "cloud_agent_credential_required" },
      { status: "unavailable", provider: "codex", code: "cloud_agent_credential_required" }] };
  const request = { bootstrap: vi.fn(async (_signal: AbortSignal): Promise<unknown> => response),
    sync: vi.fn(async (_request: unknown, _signal: AbortSignal): Promise<unknown> => response),
    refresh: vi.fn(async (_request: unknown, _signal: AbortSignal): Promise<unknown> => { throw new Error("Unexpected source refresh"); }) };
  const options = { scope, engineLive: () => live, request, time: { wall: () => wall, monotonic: () => monotonic } };
  const cache = new CloudAgentCredentialCache(options);
  caches.push(cache);
  const replace = (revision: number, entry: CloudAgentBootProviderReady = provider): CloudAgentBootCredentialResponse => ({
    ...response, cacheRevision: revision, desiredCacheRevision: revision,
    providers: response.providers.map(value => value.provider === entry.provider ? entry : value),
  });
  return { cache, options, provider, response, request, replace, scope,
    moveWall: (value: number) => { wall += value; }, moveMonotonic: (value: number) => { monotonic += value; },
    loseAuthority: () => { live = false; }, CloudAgentCredentialCache };
}
async function subscriptionFixture() {
  const f = await fixture();
  const provider: CloudAgentBootProviderReady = { ...f.provider, provider: "codex", kind: "codex-chatgpt",
    material: { kind: "codex-chatgpt", accountId: "test_account_A", accessToken: "synthetic-codex-access-A", expiresAt: 1_791_468_060 },
    expiresAt: new Date(1_791_468_060_000).toISOString(), refreshAfter: new Date(1_791_468_030_000).toISOString() };
  f.response.providers = f.response.providers.map(value => value.provider === "codex" ? provider : value);
  await f.cache.initialize();
  return { ...f, provider };
}
function rotation(f: Awaited<ReturnType<typeof subscriptionFixture>>) {
  const next = { ...f.provider, materialVersion: 2,
    material: { kind: "codex-chatgpt", accountId: "test_account_A", accessToken: "synthetic-codex-access-B", expiresAt: 1_791_468_120 },
    expiresAt: new Date(1_791_468_120_000).toISOString(), refreshAfter: new Date(1_791_468_090_000).toISOString() } satisfies CloudAgentBootProviderReady;
  const { providers: _providers, initialAdoptions: _baseline, ...identity } = f.response;
  const refreshed: CloudAgentBootRefreshResponse = { ...identity, cacheRevision: 2, desiredCacheRevision: 2, provider: next };
  return { next, refreshed, full: f.replace(2, next) };
}
function refreshDue(f: Awaited<ReturnType<typeof subscriptionFixture>>) {
  f.moveWall(30_000); f.moveMonotonic(30_000);
}

describe("background-only Codex source renewal", () => {
  it("exposes bounded nonsecret scheduling and cannot postpone refresh by rolling the wall clock back", async () => {
    const f = await subscriptionFixture();
    expect(f.cache.backgroundWork).toEqual({ synchronizeInMs: null, codexRefreshInMs: 30_000 });
    f.moveWall(-60_000); f.moveMonotonic(10_000);
    expect(f.cache.backgroundWork).toEqual({ synchronizeInMs: null, codexRefreshInMs: 20_000 });
    expect(f.request.refresh).not.toHaveBeenCalled(); expect(f.request.sync).not.toHaveBeenCalled();
    expect(JSON.stringify(f.cache.backgroundWork)).not.toContain("synthetic-codex-access-A");
    f.cache.markDesired(2);
    expect(f.cache.backgroundWork).toEqual({ synchronizeInMs: 0, codexRefreshInMs: null });
  });
  it("schedules broker authority renewal separately from token expiry and ignores API/unavailable refresh sources", async () => {
    const f = await fixture(); f.provider.authorityExpiresAt = new Date(1_791_468_010_000).toISOString();
    await f.cache.initialize();
    expect(f.cache.backgroundWork).toEqual({ synchronizeInMs: 5000, codexRefreshInMs: null });
    f.moveWall(-60_000); f.moveMonotonic(4000);
    expect(f.cache.backgroundWork).toEqual({ synchronizeInMs: 3000, codexRefreshInMs: null });
    f.moveMonotonic(6001);
    expect(f.cache.backgroundWork).toEqual({ synchronizeInMs: 0, codexRefreshInMs: null });
    await expect(f.cache.refreshCodexAccess()).rejects.toMatchObject({ code: "cloud_agent_credential_required" });
    expect(f.request.refresh).not.toHaveBeenCalled();
  });
  it("refuses early renewal and never calls CP from native auth callbacks", async () => {
    const f = await subscriptionFixture(), captured = f.cache.capture("codex", "qualified-model");
    await expect(f.cache.refreshCodexAccess()).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_rejected" });
    await expect(captured.refreshCodex(1, "test_account_A")).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_unchanged" });
    expect(f.request.refresh).not.toHaveBeenCalled(); expect(f.request.sync).not.toHaveBeenCalled();
  });
  it("single-flights exact refresh CAS then parks dispatch until full three-slot publication", async () => {
    const f = await subscriptionFixture(), r = rotation(f), source = deferred<unknown>(), publication = deferred<unknown>();
    const captured = f.cache.capture("codex", "qualified-model"); refreshDue(f);
    f.request.refresh.mockImplementation(() => source.promise); f.request.sync.mockImplementation(() => publication.promise);
    const first = f.cache.refreshCodexAccess(), second = f.cache.refreshCodexAccess();
    await vi.waitFor(() => expect(f.request.refresh).toHaveBeenCalledOnce());
    const { fundingOwnerUserId: _owner, fundingOwnerEpoch: _epoch, ...reference } = f.scope;
    expect(f.request.refresh.mock.calls[0]![0]).toEqual({ ...reference, version: 1, mode: "boot-owner-v1", provider: "codex",
      credentialId: f.provider.credentialId, credentialRevision: 2, expectedCacheRevision: 1, expectedMaterialVersion: 1 });
    source.resolve(r.refreshed);
    await vi.waitFor(() => expect(f.request.sync).toHaveBeenCalledOnce());
    expect(f.request.sync.mock.calls[0]![0]).toMatchObject({ expectedCacheRevision: 2 });
    expect(f.cache.metadata).toMatchObject({ cacheRevision: 1, desiredCacheRevision: 2 });
    expect(f.cache.readiness("claude", "qualified-model").state).toBe("pending");
    expect(() => f.cache.capture("codex", "qualified-model")).toThrow(expect.objectContaining({ code: "cloud_agent_credential_refresh_required" }));
    expect(captured.codexAuth()?.material.accessToken).toBe("synthetic-codex-access-A");
    const previousSibling = f.response.providers.find(value => value.provider === "claude");
    if (!previousSibling || previousSibling.status !== "ready") throw new Error("Missing fixture sibling");
    const sibling: CloudAgentBootProviderReady = { ...previousSibling, credentialRevision: 3, materialVersion: 2, adoptionId: randomUUID(),
      material: { kind: "claude-api-key", apiKey: "synthetic-current-sibling-B" } };
    publication.resolve({ ...r.full, providers: r.full.providers.map(value => value.provider === "claude" ? sibling : value) });
    await Promise.all([first, second]);
    expect(captured.codexAuth()?.material).toEqual(r.next.material);
    expect(f.cache.capture("claude", "qualified-model").takeMaterial()).toEqual(sibling.material);
    f.request.refresh.mockClear(); f.request.sync.mockClear();
    await expect(captured.refreshCodex(1, "test_account_A")).resolves.toMatchObject({ material: r.next.material, credentialVersion: 2 });
    expect(f.request.refresh).not.toHaveBeenCalled(); expect(f.request.sync).not.toHaveBeenCalled();
  });
  it("waits for an older sync flight before capturing CAS and shares the entire refresh publication", async () => {
    const f = await subscriptionFixture(), r = rotation(f), previous = deferred<unknown>(), source = deferred<unknown>();
    refreshDue(f); f.request.sync.mockImplementationOnce(() => previous.promise).mockResolvedValueOnce(r.full);
    f.request.refresh.mockImplementation(() => source.promise);
    const oldSync = f.cache.synchronize(), refreshed = f.cache.refreshCodexAccess(), shared = f.cache.synchronize();
    expect(f.request.refresh).not.toHaveBeenCalled();
    previous.resolve(f.response); await oldSync;
    await vi.waitFor(() => expect(f.request.refresh).toHaveBeenCalledOnce());
    source.resolve(r.refreshed); await Promise.all([refreshed, shared]);
    expect(f.request.sync).toHaveBeenCalledTimes(2);
    expect(f.cache.capture("codex", "qualified-model").takeMaterial()).toEqual(r.next.material);
  });
  it.each(["boot", "writer", "owner", "authority", "cache", "dirty", "credential", "revision", "connection", "account", "material"])(
    "rejects an invalid %s refresh proof before full publication", async kind => {
      const f = await subscriptionFixture(), r = rotation(f); refreshDue(f);
      const changed = kind === "boot" ? { ...r.refreshed, bootId: randomUUID() } :
        kind === "writer" ? { ...r.refreshed, writerEpoch: randomUUID() } :
        kind === "owner" ? { ...r.refreshed, fundingOwnerUserId: randomUUID() } :
        kind === "authority" ? { ...r.refreshed, authorityEpoch: 2 } :
        kind === "cache" ? { ...r.refreshed, cacheRevision: 1, desiredCacheRevision: 1 } :
        kind === "dirty" ? { ...r.refreshed, desiredCacheRevision: 3 } :
        { ...r.refreshed, provider: { ...r.next, ...(kind === "credential" ? { credentialId: randomUUID() } :
          kind === "revision" ? { credentialRevision: 3 } : kind === "connection" ? { connectionRevision: 4 } :
          kind === "account" ? { material: { ...r.next.material, accountId: "test_account_B" } } : { materialVersion: 1 }) } };
      f.request.refresh.mockResolvedValue(changed);
      await expect(f.cache.refreshCodexAccess()).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_invalid" });
      expect(f.request.sync).not.toHaveBeenCalled(); expect(f.cache.metadata.cacheRevision).toBe(1);
    });
  it.each(["dirty", "revoked", "disposed", "authority-expired"])("rejects a late response after %s without installing old selection", async kind => {
    const f = await subscriptionFixture();
    if (kind === "authority-expired") {
      f.provider.authorityExpiresAt = new Date(1_791_468_031_000).toISOString();
      f.request.sync.mockResolvedValue(f.replace(2, f.provider)); await f.cache.synchronize(); f.request.sync.mockClear();
    }
    const r = rotation(f), source = deferred<unknown>(); refreshDue(f); f.request.refresh.mockImplementation(() => source.promise);
    const refreshing = f.cache.refreshCodexAccess();
    await vi.waitFor(() => expect(f.request.refresh).toHaveBeenCalledOnce());
    if (kind === "dirty") f.cache.markDesired(3);
    else if (kind === "revoked") f.cache.revokeCredential(f.provider.credentialId);
    else if (kind === "disposed") f.cache.dispose();
    else f.moveMonotonic(1001);
    source.resolve(kind === "authority-expired" ? { ...r.refreshed, cacheRevision: 3, desiredCacheRevision: 3 } : r.refreshed);
    await expect(refreshing).rejects.toMatchObject({ code: kind === "dirty" ? "cloud_validation_credential_refresh_invalid" :
      kind === "revoked" ? "cloud_agent_credential_revoked" : kind === "disposed" ? "cloud_validation_lifecycle_superseded" : "cloud_agent_credential_expired" });
    expect(f.request.sync).not.toHaveBeenCalled();
  });
  it.each(["revision", "missing-rotation", "same-version-bytes"])("refuses %s full-sync proof while preserving the dirty barrier", async kind => {
    const f = await subscriptionFixture(), r = rotation(f); refreshDue(f); f.request.refresh.mockResolvedValue(r.refreshed);
    const full = kind === "revision" ? f.response : kind === "missing-rotation" ? f.replace(2, f.provider) :
      f.replace(3, { ...r.next, material: { ...r.next.material, accessToken: "synthetic-conflicting-same-version" } });
    f.request.sync.mockResolvedValue(full);
    await expect(f.cache.refreshCodexAccess()).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_invalid" });
    expect(f.cache.metadata).toMatchObject({ cacheRevision: 1, desiredCacheRevision: 2 });
    expect(f.cache.readiness("codex", "qualified-model").state).toBe("pending");
  });
  it("publishes a genuinely newer full replacement without injecting it into the old account", async () => {
    const f = await subscriptionFixture(), r = rotation(f), captured = f.cache.capture("codex", "qualified-model"); refreshDue(f);
    const replacement: CloudAgentBootProviderReady = { ...r.next, credentialId: randomUUID(), adoptionId: randomUUID(),
      material: { kind: "codex-chatgpt", accountId: "test_account_B", accessToken: "synthetic-current-account-B", expiresAt: 1_791_468_120 } };
    f.request.refresh.mockResolvedValue(r.refreshed); f.request.sync.mockResolvedValue(f.replace(3, replacement));
    await f.cache.refreshCodexAccess();
    expect(f.cache.capture("codex", "qualified-model").takeMaterial()).toEqual(replacement.material);
    expect(captured.codexAuth()?.material.accountId).toBe("test_account_A");
    await expect(captured.refreshCodex(1, "test_account_A")).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_rejected" });
  });
  it("retains typed source refusal and performs no fallback sync", async () => {
    const f = await subscriptionFixture(); refreshDue(f);
    f.request.refresh.mockRejectedValue(Object.assign(new Error("private refusal"), { code: "cloud_validation_credential_refresh_rejected" }));
    await expect(f.cache.refreshCodexAccess()).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_rejected" });
    expect(f.request.sync).not.toHaveBeenCalled();
  });
  it("keeps new starts parked after a typed full-publication failure", async () => {
    const f = await subscriptionFixture(), r = rotation(f); refreshDue(f);
    f.request.refresh.mockResolvedValue(r.refreshed);
    f.request.sync.mockRejectedValue(Object.assign(new Error("private transport refusal"), { code: "cloud_validation_authority_transport" }));
    await expect(f.cache.refreshCodexAccess()).rejects.toMatchObject({ code: "cloud_validation_authority_transport" });
    expect(f.cache.metadata).toMatchObject({ cacheRevision: 1, desiredCacheRevision: 2 });
    expect(f.cache.backgroundWork).toEqual({ synchronizeInMs: 0, codexRefreshInMs: null });
    expect(() => f.cache.capture("claude", "qualified-model")).toThrow(expect.objectContaining({ code: "cloud_agent_credential_refresh_required" }));
    expect(f.request.bootstrap).toHaveBeenCalledOnce(); expect(f.request.refresh).toHaveBeenCalledOnce(); expect(f.request.sync).toHaveBeenCalledOnce();
  });
  it("preserves a real source grant deadline across token rotation and wall clock rollback", async () => {
    const f = await subscriptionFixture();
    f.provider.authorityExpiresAt = new Date(1_791_468_040_000).toISOString();
    f.request.sync.mockResolvedValueOnce(f.replace(2, f.provider)); await f.cache.synchronize();
    const r = rotation(f); refreshDue(f); f.moveWall(-60_000);
    f.request.refresh.mockResolvedValue({ ...r.refreshed, cacheRevision: 3, desiredCacheRevision: 3 });
    f.request.sync.mockResolvedValue(f.replace(3, r.next)); await f.cache.refreshCodexAccess();
    const capture = f.cache.capture("codex", "qualified-model");
    f.moveMonotonic(10_001);
    expect(() => capture.assertLive()).toThrow(expect.objectContaining({ code: "cloud_agent_credential_expired" }));
    expect(capture.signal.aborted).toBe(true);
  });
  it("refuses a known dirty selection and a ready API key without calling the subscription source", async () => {
    const f = await subscriptionFixture(); refreshDue(f); f.cache.markDesired(2);
    await expect(f.cache.refreshCodexAccess()).rejects.toMatchObject({ code: "cloud_agent_credential_refresh_required" });
    expect(f.request.refresh).not.toHaveBeenCalled();
    const g = await fixture(), provider: CloudAgentBootProviderReady = { ...g.provider, provider: "codex", kind: "codex-api-key",
      material: { kind: "codex-api-key", apiKey: "synthetic-codex-api-source" } };
    g.response.providers = g.response.providers.map(value => value.provider === "codex" ? provider : value);
    await g.cache.initialize(); expect(g.cache.backgroundWork.codexRefreshInMs).toBeNull();
    await expect(g.cache.refreshCodexAccess()).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_rejected" });
    expect(g.request.refresh).not.toHaveBeenCalled(); expect(g.request.sync).not.toHaveBeenCalled();
  });
  it("requires an actual refresh requester rather than fabricating a successful renewal", async () => {
    const f = await subscriptionFixture(); refreshDue(f);
    const { refresh: _refresh, ...request } = f.request;
    const cache = new f.CloudAgentCredentialCache({ ...f.options, request }); caches.push(cache); await cache.initialize();
    await expect(cache.refreshCodexAccess()).rejects.toMatchObject({ code: "cloud_validation_authority_unavailable" });
    expect(f.request.sync).not.toHaveBeenCalled();
  });
});

describe("boot credential cache current selection", () => {
  it("single-flights initialization and exposes no credential in boot metadata", async () => {
    const f = await fixture(), pending = deferred<unknown>();
    f.request.bootstrap.mockImplementation(() => pending.promise);
    const first = f.cache.initialize(), second = f.cache.initialize();
    expect(f.request.bootstrap).toHaveBeenCalledOnce();
    pending.resolve(f.response); await Promise.all([first, second]);
    expect(f.cache.metadata.cacheRevision).toBe(1);
    expect(JSON.stringify(f.cache.metadata)).not.toContain("synthetic-private-provider-A");
    await f.cache.initialize(); expect(f.request.bootstrap).toHaveBeenCalledOnce();
  });
  it("does no CP work during readiness, dispatch capture or native material consumption", async () => {
    const f = await fixture(); await f.cache.initialize();
    f.request.bootstrap.mockClear(); f.request.sync.mockClear();
    expect(f.cache.readiness("claude", "qualified-model").state).toBe("ready");
    const capture = f.cache.capture("claude", "qualified-model"); capture.assertLive();
    expect(capture.takeMaterial()).toEqual(f.provider.material);
    expect(() => capture.takeMaterial()).toThrow();
    expect(f.request.bootstrap).not.toHaveBeenCalled(); expect(f.request.sync).not.toHaveBeenCalled();
    expect(JSON.stringify(capture)).not.toContain("synthetic-private-provider-A");
  });
  it("captures at dispatch so the next run uses background-published material while the active run retains A", async () => {
    const f = await fixture(); await f.cache.initialize();
    const active = f.cache.capture("claude", "qualified-model");
    f.cache.markDesired(2);
    expect(f.cache.readiness("claude", "qualified-model").state).toBe("pending");
    expect(() => f.cache.capture("claude", "qualified-model")).toThrow(expect.objectContaining({ code: "cloud_agent_credential_refresh_required" }));
    const next = { ...f.provider, credentialId: randomUUID(), adoptionId: randomUUID(), material: { kind: "claude-api-key" as const, apiKey: "synthetic-private-provider-B" } };
    f.request.sync.mockResolvedValue(f.replace(2, next)); await f.cache.synchronize();
    expect(active.takeMaterial()).toEqual(f.provider.material);
    const captured = f.cache.capture("claude", "qualified-model");
    expect(captured.takeMaterial()).toEqual(next.material); expect(captured.runInfo.cacheRevision).toBe(2);
  });
  it("refuses an unsubmitted A capture after B becomes ready while an entered A run stays live", async () => {
    const f = await fixture(); await f.cache.initialize(); const reserved = f.cache.capture("claude", "qualified-model");
    f.cache.assertCurrentSelection(reserved, "qualified-model");
    f.cache.markDesired(2);
    expect(() => f.cache.assertCurrentSelection(reserved, "qualified-model")).toThrow(expect.objectContaining({ code: "cloud_agent_credential_refresh_required" }));
    const next = { ...f.provider, credentialId: randomUUID(), material: { kind: "claude-api-key" as const, apiKey: "synthetic-private-provider-B" } };
    f.request.sync.mockResolvedValue(f.replace(2, next)); await f.cache.synchronize();
    expect(() => f.cache.assertCurrentSelection(reserved, "qualified-model")).toThrow(expect.objectContaining({ code: "cloud_validation_lifecycle_superseded" }));
    reserved.assertLive(); expect(reserved.takeMaterial()).toEqual(f.provider.material);
    expect(f.request.sync).toHaveBeenCalledOnce();
  });
  it("does not fence an unchanged provider selection just because another provider advanced the cache", async () => {
    const f = await fixture(); await f.cache.initialize(); const reserved = f.cache.capture("claude", "qualified-model");
    f.request.sync.mockResolvedValue(f.replace(2)); await f.cache.synchronize();
    f.request.bootstrap.mockClear(); f.request.sync.mockClear(); f.cache.assertCurrentSelection(reserved, "qualified-model");
    expect(f.request.bootstrap).not.toHaveBeenCalled(); expect(f.request.sync).not.toHaveBeenCalled();
  });
  it("checks current provider policy and private material rather than adoption presentation identity", async () => {
    const f = await fixture(); await f.cache.initialize(); const reserved = f.cache.capture("claude", "qualified-model");
    f.request.sync.mockResolvedValue(f.replace(2, { ...f.provider, nativeCapabilities: { ...capabilities, transcriptFork: true } }));
    await f.cache.synchronize(); expect(() => f.cache.assertCurrentSelection(reserved, "qualified-model")).toThrow();
    const g = await fixture(); await g.cache.initialize(); const original = g.cache.capture("claude", "qualified-model");
    g.request.sync.mockResolvedValue(g.replace(2, { ...g.provider, material: { kind: "claude-api-key", apiKey: "synthetic-private-provider-B" } }));
    await g.cache.synchronize(); expect(() => g.cache.assertCurrentSelection(original, "qualified-model")).toThrow();
    expect(() => g.cache.assertCurrentSelection({ ...original } as typeof original, "qualified-model")).toThrow();
  });
  it("keeps a known dirty barrier when an older response arrives late", async () => {
    const f = await fixture(); await f.cache.initialize();
    const pending = deferred<unknown>(); f.request.sync.mockImplementation(() => pending.promise);
    const sync = f.cache.synchronize(); f.cache.markDesired(3); pending.resolve(f.replace(2));
    await expect(sync).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_invalid" });
    expect(f.cache.readiness("claude", "qualified-model")).toMatchObject({ state: "pending", desiredCacheRevision: 3 });
    expect(() => f.cache.capture("claude", "qualified-model")).toThrow();
  });
  it("single-flights background synchronization independently of Send", async () => {
    const f = await fixture(); await f.cache.initialize(); f.cache.markDesired(2);
    const pending = deferred<unknown>(); f.request.sync.mockImplementation(() => pending.promise);
    const a = f.cache.synchronize(), b = f.cache.synchronize();
    expect(f.request.sync).toHaveBeenCalledOnce(); pending.resolve(f.replace(2)); await Promise.all([a, b]);
  });
  it.each(["bootId", "writerEpoch", "fundingOwnerUserId", "engineInstanceId"])("rejects substituted %s", async field => {
    const f = await fixture(); f.request.bootstrap.mockResolvedValue({ ...f.response, [field]: randomUUID() });
    await expect(f.cache.initialize()).rejects.toMatchObject({ code: "cloud_validation_authority_response_invalid" });
  });
  it("rejects equal-revision material replacement and immutable initial baseline changes", async () => {
    const f = await fixture(); await f.cache.initialize();
    f.request.sync.mockResolvedValue(f.replace(1, { ...f.provider, material: { kind: "claude-api-key", apiKey: "synthetic-private-provider-B" } }));
    await expect(f.cache.synchronize()).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_invalid" });
    f.request.sync.mockResolvedValue({ ...f.replace(2), initialAdoptions: f.response.initialAdoptions.map(value => value.provider === "claude" ? { provider: "claude", status: "unknown" } : value) });
    await expect(f.cache.synchronize()).rejects.toMatchObject({ code: "cloud_validation_authority_response_invalid" });
  });
  it("copies private response material before external mutation", async () => {
    const f = await fixture(); await f.cache.initialize();
    (f.provider.material as { apiKey: string }).apiKey = "synthetic-untrusted-mutation";
    expect(f.cache.capture("claude", "qualified-model").takeMaterial()).toEqual({ kind: "claude-api-key", apiKey: "synthetic-private-provider-A" });
  });
  it("keeps missing provider and unauthorized model guidance closed without fallback", async () => {
    const f = await fixture(); await f.cache.initialize();
    expect(() => f.cache.capture("cursor", "qualified-model")).toThrow(expect.objectContaining({ code: "cloud_agent_credential_required" }));
    expect(() => f.cache.capture("claude", "other-model")).toThrow(expect.objectContaining({ code: "cloud_agent_model_not_authorized" }));
    expect(f.request.bootstrap).toHaveBeenCalledOnce(); expect(f.request.sync).not.toHaveBeenCalled();
  });
  it("accepts dirty bootstrap without exposing ready material", async () => {
    const f = await fixture(); f.request.bootstrap.mockResolvedValue({ ...f.response, desiredCacheRevision: 2,
      providers: f.response.providers.map(value => ({ status: "unavailable", provider: value.provider, code: "cloud_agent_credential_refresh_required" })) });
    await f.cache.initialize(); expect(f.cache.readiness("claude", "qualified-model").state).toBe("pending");
    expect(() => f.cache.capture("claude", "qualified-model")).toThrow();
  });
  it("rejects dirty material and admin/refresh material at the boundary", async () => {
    const f = await fixture(); f.request.bootstrap.mockResolvedValue({ ...f.response, desiredCacheRevision: 2 });
    await expect(f.cache.initialize()).rejects.toMatchObject({ code: "cloud_validation_authority_response_invalid" });
    f.request.bootstrap.mockResolvedValue({ ...f.response, providers: [{ ...f.provider, material: { ...f.provider.material, refreshToken: "synthetic-private-refresh" } }, ...f.response.providers.slice(1)] });
    await expect(f.cache.initialize()).rejects.toMatchObject({ code: "cloud_validation_authority_response_invalid" });
  });
  it.each(["wall", "monotonic"])("enforces source authorization expiry with the %s clock", async kind => {
    const f = await fixture(); f.provider.authorityExpiresAt = new Date(1_791_468_001_000).toISOString();
    await f.cache.initialize(); const capture = f.cache.capture("claude", "qualified-model");
    (kind === "wall" ? f.moveWall : f.moveMonotonic)(1001);
    expect(() => capture.assertLive()).toThrow(expect.objectContaining({ code: "cloud_agent_credential_expired" }));
    expect(capture.signal.aborted).toBe(true);
  });
  it("bounds live captured scopes and releases capacity only when their owner releases them", async () => {
    const f = await fixture(), bounded = new f.CloudAgentCredentialCache({ ...f.options, maxCaptures: 1 }); caches.push(bounded);
    await bounded.initialize(); const first = bounded.capture("claude", "qualified-model");
    expect(() => bounded.capture("claude", "qualified-model")).toThrow(expect.objectContaining({ code: "cloud_validation_execution_limit" }));
    first.release(); expect(() => bounded.capture("claude", "qualified-model")).not.toThrow();
    expect(() => first.assertLive()).toThrow();
  });
  it("revokes every affected old capture and cannot reinstall removed material", async () => {
    const f = await fixture(); await f.cache.initialize(); const first = f.cache.capture("claude", "qualified-model");
    f.cache.revokeCredential(f.provider.credentialId);
    expect(first.signal.aborted).toBe(true);
    expect(() => first.assertLive()).toThrow(expect.objectContaining({ code: "cloud_agent_credential_revoked" }));
    f.request.sync.mockResolvedValue(f.replace(2));
    await expect(f.cache.synchronize()).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_invalid" });
    expect(() => f.cache.capture("claude", "qualified-model")).toThrow(expect.objectContaining({ code: "cloud_agent_credential_revoked" }));
  });
  it("admits a fresh association only above both retired source floors and never revives the old capture", async () => {
    const f = await fixture(); await f.cache.initialize(); const first = f.cache.capture("claude", "qualified-model");
    f.cache.retireAssociation("claude", f.provider.credentialId);
    expect(first.signal.aborted).toBe(true);
    expect(() => first.assertLive()).toThrow(expect.objectContaining({ code: "cloud_agent_credential_revoked" }));
    expect(() => f.cache.capture("claude", "qualified-model")).toThrow(expect.objectContaining({ code: "cloud_agent_credential_revoked" }));
    const next = { ...f.provider, connectionRevision: f.provider.connectionRevision + 1 };
    f.request.sync.mockResolvedValue(f.replace(2, next)); await f.cache.synchronize();
    const fresh = f.cache.capture("claude", "qualified-model");
    expect(fresh.runInfo).toMatchObject({ credentialId: first.runInfo.credentialId, cacheRevision: 2, connectionRevision: 4 });
    fresh.assertLive(); expect(() => first.assertLive()).toThrow(expect.objectContaining({ code: "cloud_agent_credential_revoked" }));
    expect(() => f.cache.assertCurrentSelection(first, "qualified-model")).toThrow();
  });
  it.each(["connection-only", "cache-only", "token-only", "lower-connection"])("refuses %s publication across an association retirement", async kind => {
    const f = await fixture(); await f.cache.initialize(); f.cache.retireAssociation("claude", f.provider.credentialId);
    const next = { ...f.provider, connectionRevision: f.provider.connectionRevision + (kind === "connection-only" ? 1 : kind === "lower-connection" ? -1 : 0),
      materialVersion: f.provider.materialVersion + (kind === "token-only" ? 1 : 0) };
    f.request.sync.mockResolvedValue(f.replace(kind === "connection-only" ? 1 : 2, next));
    await expect(f.cache.synchronize()).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_invalid" });
    expect(f.cache.metadata.cacheRevision).toBe(1);
    expect(() => f.cache.capture("claude", "qualified-model")).toThrow(expect.objectContaining({ code: "cloud_agent_credential_revoked" }));
  });
  it("keeps successive association high-water fences from trusted published revisions", async () => {
    const f = await fixture(); await f.cache.initialize();
    f.request.sync.mockResolvedValue(f.replace(3)); await f.cache.synchronize();
    expect(f.cache.associationFloor("claude", f.provider.credentialId)).toEqual({ cacheRevision: 3, connectionRevision: 3 });
    f.cache.retireAssociation("claude", f.provider.credentialId);
    const next = { ...f.provider, connectionRevision: 4 };
    f.request.sync.mockResolvedValue(f.replace(3, next));
    await expect(f.cache.synchronize()).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_invalid" });
    f.request.sync.mockResolvedValue(f.replace(4, next)); await f.cache.synchronize();
    const second = f.cache.capture("claude", "qualified-model");
    f.cache.retireAssociation("claude", f.provider.credentialId);
    f.request.sync.mockResolvedValue(f.replace(5, next));
    await expect(f.cache.synchronize()).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_invalid" });
    f.request.sync.mockResolvedValue(f.replace(5, { ...next, connectionRevision: 5 })); await f.cache.synchronize();
    f.cache.capture("claude", "qualified-model").assertLive();
    expect(() => second.assertLive()).toThrow(expect.objectContaining({ code: "cloud_agent_credential_revoked" }));
  });
  it("refuses a delayed old full publication after retirement without lowering its fences", async () => {
    const f = await fixture(); await f.cache.initialize(); const old = f.cache.capture("claude", "qualified-model");
    const pending = deferred<unknown>(); f.request.sync.mockImplementationOnce(() => pending.promise);
    const syncing = f.cache.synchronize(); f.cache.retireAssociation("claude", f.provider.credentialId);
    pending.resolve(f.replace(2));
    await expect(syncing).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_invalid" });
    expect(f.cache.associationFloor("claude", f.provider.credentialId)).toEqual({ cacheRevision: 1, connectionRevision: 3 });
    f.request.sync.mockResolvedValue(f.replace(3, { ...f.provider, connectionRevision: 4 })); await f.cache.synchronize();
    f.cache.capture("claude", "qualified-model").assertLive();
    expect(() => old.assertLive()).toThrow(expect.objectContaining({ code: "cloud_agent_credential_revoked" }));
  });
  it("rejects delayed old Codex refresh before publication and never revives its native capture", async () => {
    const f = await subscriptionFixture(), r = rotation(f), pending = deferred<unknown>();
    const old = f.cache.capture("codex", "qualified-model"); refreshDue(f);
    f.request.refresh.mockImplementationOnce(() => pending.promise);
    const refreshing = f.cache.refreshCodexAccess();
    await vi.waitFor(() => expect(f.request.refresh).toHaveBeenCalledOnce());
    f.cache.retireAssociation("codex", f.provider.credentialId); pending.resolve(r.refreshed);
    await expect(refreshing).rejects.toMatchObject({ code: "cloud_agent_credential_revoked" });
    expect(f.request.sync).not.toHaveBeenCalled(); expect(f.cache.metadata.cacheRevision).toBe(1);
    expect(() => old.codexAuth()).toThrow(expect.objectContaining({ code: "cloud_agent_credential_revoked" }));
  });
  it("never treats a newer association as proof that a globally revoked credential is live", async () => {
    const f = await fixture(); await f.cache.initialize(); f.cache.revokeCredential(f.provider.credentialId);
    f.request.sync.mockResolvedValue(f.replace(2, { ...f.provider, connectionRevision: 4 }));
    await expect(f.cache.synchronize()).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_invalid" });
    expect(() => f.cache.capture("claude", "qualified-model")).toThrow(expect.objectContaining({ code: "cloud_agent_credential_revoked" }));
  });
  it("does not infer an unknown association floor or evict it to admit later material", async () => {
    const f = await fixture(), unknown = randomUUID(); await f.cache.initialize(); f.cache.retireAssociation("claude", unknown);
    expect(f.cache.associationFloor("claude", unknown)).toBeNull();
    f.request.sync.mockResolvedValue(f.replace(2, { ...f.provider, credentialId: unknown, connectionRevision: 100 }));
    await expect(f.cache.synchronize()).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_invalid" });
    f.cache.capture("claude", "qualified-model").assertLive();
  });
  it("keeps association retirement scoped to the exact provider", async () => {
    const f = await fixture();
    const sibling = { ...f.provider, provider: "cursor" as const, kind: "cursor-api-key" as const,
      material: { kind: "cursor-api-key" as const, apiKey: "synthetic-private-sibling" } };
    f.response.providers = f.response.providers.map(value => value.provider === "cursor" ? sibling : value);
    await f.cache.initialize(); const cursor = f.cache.capture("cursor", "qualified-model");
    f.cache.retireAssociation("claude", f.provider.credentialId);
    cursor.assertLive(); expect(cursor.signal.aborted).toBe(false);
    f.cache.capture("cursor", "qualified-model").assertLive();
  });
  it("never treats an unrelated provider publication as a new association", async () => {
    const f = await fixture();
    const sibling = { ...f.provider, provider: "cursor" as const, kind: "cursor-api-key" as const,
      credentialId: randomUUID(), material: { kind: "cursor-api-key" as const, apiKey: "synthetic-private-sibling" } };
    f.response.providers = f.response.providers.map(value => value.provider === "cursor" ? sibling : value);
    await f.cache.initialize(); const cursor = f.cache.capture("cursor", "qualified-model");
    f.cache.retireAssociation("claude", f.provider.credentialId);
    const next = { ...sibling, connectionRevision: sibling.connectionRevision + 1 };
    f.request.sync.mockResolvedValue(f.replace(2, next));
    await expect(f.cache.synchronize()).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_invalid" });
    cursor.assertLive(); expect(f.cache.metadata.cacheRevision).toBe(1);
    expect(() => f.cache.capture("claude", "qualified-model")).toThrow(expect.objectContaining({ code: "cloud_agent_credential_revoked" }));
  });
  it("fails closed at the finite association fence limit instead of evicting old authority", async () => {
    const f = await fixture(); await f.cache.initialize(); const capture = f.cache.capture("claude", "qualified-model");
    for (let i = 0; i < 1024; i++) f.cache.retireAssociation("claude", randomUUID());
    expect(() => f.cache.retireAssociation("claude", randomUUID())).toThrow(expect.objectContaining({ code: "cloud_validation_execution_limit" }));
    expect(capture.signal.aborted).toBe(true);
  });
  it("quarantines all captures on engine loss and rejects a late initialization", async () => {
    const f = await fixture(); await f.cache.initialize(); const captured = f.cache.capture("claude", "qualified-model");
    f.loseAuthority(); expect(() => captured.assertLive()).toThrow(expect.objectContaining({ code: "cloud_validation_lifecycle_superseded" }));
    expect(captured.signal.aborted).toBe(true);
    const g = await fixture(), pending = deferred<unknown>(); g.request.bootstrap.mockImplementation(() => pending.promise);
    const starting = g.cache.initialize(); g.cache.dispose(); pending.resolve(g.response);
    await expect(starting).rejects.toMatchObject({ code: "cloud_validation_lifecycle_superseded" });
  });
});

describe("published Codex access rotation", () => {
  it("keeps first-handoff policy pinned to the original selection while adopting same-account token rotation", async () => {
    const f = await subscriptionFixture(), captured = f.cache.capture("codex", "qualified-model");
    const next: CloudAgentBootProviderReady = { ...f.provider, materialVersion: 2,
      nativeCapabilities: { ...f.provider.nativeCapabilities, goals: true },
      material: { kind: "codex-chatgpt", accountId: "test_account_A", accessToken: "synthetic-codex-access-B", expiresAt: 1_791_468_120 },
      expiresAt: new Date(1_791_468_120_000).toISOString(), refreshAfter: new Date(1_791_468_090_000).toISOString() };
    f.request.sync.mockResolvedValue(f.replace(2, next)); await f.cache.synchronize();
    expect(captured.codexAuth()?.material).toEqual(next.material);
    expect(captured.nativeCapabilities.goals).toBe(false);
    expect(() => f.cache.assertCurrentSelection(captured, "qualified-model")).toThrow(expect.objectContaining({ code: "cloud_validation_lifecycle_superseded" }));
    expect(() => captured.assertLive()).not.toThrow();
  });
  it("uses a ready same-account epoch locally without a CP call in the native callback", async () => {
    const f = await subscriptionFixture(); const captured = f.cache.capture("codex", "qualified-model");
    const next: CloudAgentBootProviderReady = { ...f.provider, materialVersion: 2,
      material: { kind: "codex-chatgpt", accountId: "test_account_A", accessToken: "synthetic-codex-access-B", expiresAt: 1_791_468_120 },
      expiresAt: new Date(1_791_468_120_000).toISOString(), refreshAfter: new Date(1_791_468_090_000).toISOString() };
    f.request.sync.mockResolvedValue(f.replace(2, next)); await f.cache.synchronize(); f.request.sync.mockClear();
    expect(await captured.refreshCodex(1, "test_account_A")).toEqual({ material: next.material, credentialVersion: 2 });
    expect(f.request.sync).not.toHaveBeenCalled(); expect(captured.runInfo.materialVersion).toBe(1);
  });
  it("cannot adopt a different account into the active native host", async () => {
    const f = await subscriptionFixture(); const captured = f.cache.capture("codex", "qualified-model");
    const next: CloudAgentBootProviderReady = { ...f.provider, credentialId: randomUUID(), adoptionId: randomUUID(),
      materialVersion: 2, material: { kind: "codex-chatgpt", accountId: "test_account_B", accessToken: "synthetic-codex-access-B", expiresAt: 1_791_468_060 } };
    f.request.sync.mockResolvedValue(f.replace(2, next)); await f.cache.synchronize();
    await expect(captured.refreshCodex(1, "test_account_A")).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_rejected" });
    expect(captured.codexAuth()?.material.accountId).toBe("test_account_A");
    f.moveMonotonic(60_001);
    expect(() => captured.assertLive()).toThrow(expect.objectContaining({ code: "cloud_agent_credential_expired" }));
  });
  it("does not revive an expired capture when a positive same-account token arrives late", async () => {
    const f = await subscriptionFixture(); const captured = f.cache.capture("codex", "qualified-model");
    f.moveMonotonic(60_001);
    const next: CloudAgentBootProviderReady = { ...f.provider, materialVersion: 2,
      material: { kind: "codex-chatgpt", accountId: "test_account_A", accessToken: "synthetic-codex-access-B", expiresAt: 1_791_468_120 },
      expiresAt: new Date(1_791_468_120_000).toISOString(), refreshAfter: new Date(1_791_468_090_000).toISOString() };
    f.request.sync.mockResolvedValue(f.replace(2, next)); await f.cache.synchronize();
    expect(captured.signal.aborted).toBe(true);
    expect(() => captured.assertLive()).toThrow(expect.objectContaining({ code: "cloud_agent_credential_expired" }));
  });
  it("refuses unavailable background rotation without starting a foreground refresh", async () => {
    const f = await subscriptionFixture(); const captured = f.cache.capture("codex", "qualified-model");
    await expect(captured.refreshCodex(1, "test_account_A")).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_unchanged" });
    await expect(captured.refreshCodex(1, "foreign_account")).rejects.toMatchObject({ code: "cloud_validation_credential_refresh_invalid" });
    expect(f.request.sync).not.toHaveBeenCalled();
  });
  it("never uses adoptionId as proof that native account scopes match", async () => {
    const f = await subscriptionFixture(); const a = f.cache.capture("codex", "qualified-model");
    const changed: CloudAgentBootProviderReady = { ...f.provider,
      material: { kind: "codex-chatgpt", accountId: "test_account_B", accessToken: "synthetic-codex-access-B", expiresAt: 1_791_468_060 } };
    f.request.sync.mockResolvedValue(f.replace(2, changed)); await f.cache.synchronize();
    const b = f.cache.capture("codex", "qualified-model");
    expect(f.cache.sameAuthScope(a, b)).toBe(false);
  });
});
