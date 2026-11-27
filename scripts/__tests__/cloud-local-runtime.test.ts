import { describe, expect, it, vi } from "vitest";
import { maintainLocalRuntimes, maintainLocalWebhooks, markLocalRuntime, removeLocalRuntimeUses, resolveLocalRuntime, runtimeBuildMode,
  runtimeRetentionSummary, webhookCleanupSummary } from "../dev-environment/cloud-local-runtime.mjs";

const source = { sourceSha256: "a".repeat(64), commit: "b".repeat(40), dirty: false };
const record = { version: 1, ...source, sha256: "c".repeat(64) };
function fixture() {
  const workspace: any = { state: {} }, profile = { storage: { secretAccessKey: "fixture-storage-secret" } };
  const options = { override: undefined, source: vi.fn(async () => source), lookup: vi.fn(async () => record as any),
    publish: vi.fn(async () => record), buildMode: vi.fn(async () => ({ docker: false })), save: vi.fn(), signal: new AbortController().signal };
  return { workspace, profile, options, run: () => resolveLocalRuntime(workspace, profile, "/fixture", options) };
}
describe("electron:cloud automatic runtime", () => {
  it("uses the published source match and records only non-secret metadata", async () => {
    const f = fixture();
    expect(await f.run()).toBe(record.sha256);
    expect(f.options.publish).not.toHaveBeenCalled(); expect(f.options.buildMode).not.toHaveBeenCalled();
    expect(f.workspace.state.cloudRuntime).toMatchObject({ sourceSha256: source.sourceSha256, sha256: record.sha256, commit: source.commit });
    expect(JSON.stringify(f.workspace.state)).not.toContain("fixture-storage-secret");
  });
  it("builds and publishes once only for a confirmed missing match", async () => {
    const f = fixture(); f.options.lookup.mockResolvedValue(null);
    expect(await f.run()).toBe(record.sha256);
    expect(f.options.publish).toHaveBeenCalledOnce();
    expect(f.options.publish).toHaveBeenCalledWith(expect.objectContaining({ storage: f.profile.storage,
      expectedSourceSha256: source.sourceSha256, allowDirty: true, docker: false }));
  });
  it("does not reuse a stale saved pin, accept another source, or build on a lookup error", async () => {
    const f = fixture(); f.workspace.state.cloudRuntime = { ...record, sourceSha256: "d".repeat(64) };
    f.options.lookup.mockRejectedValueOnce(new Error("fixture-storage-secret"));
    await expect(f.run()).rejects.toThrow(/lookup/);
    expect(f.options.publish).not.toHaveBeenCalled();
    f.options.lookup.mockResolvedValueOnce({ ...record, sourceSha256: "e".repeat(64) });
    await expect(f.run()).rejects.toThrow(/source/);
    expect(f.options.publish).not.toHaveBeenCalled();
  });
  it("refuses source changes during lookup or publication without committing a pin", async () => {
    const f = fixture(); f.options.source.mockResolvedValueOnce(source).mockResolvedValue({ ...source, sourceSha256: "d".repeat(64) });
    await expect(f.run()).rejects.toThrow(/changed/);
    expect(f.options.save).not.toHaveBeenCalled();
  });
  it("keeps explicit pins as an override, without builds or storage access", async () => {
    const f = fixture();
    expect(await resolveLocalRuntime(f.workspace, f.profile, "/fixture", { ...f.options, override: record.sha256 })).toBe(record.sha256);
    expect(f.options.source).not.toHaveBeenCalled(); expect(f.options.lookup).not.toHaveBeenCalled();
    await expect(resolveLocalRuntime(f.workspace, f.profile, "/fixture", { ...f.options, override: "bad" })).rejects.toThrow(/runtime/);
  });
  it("uses native Linux Node 24, Docker on Mac, and one clear missing-Docker instruction", async () => {
    const run = vi.fn(async () => "24");
    expect(await runtimeBuildMode({ platform: "linux", arch: "x64", node: "24.18.1", run })).toEqual({ docker: false });
    expect(run).not.toHaveBeenCalled();
    expect(await runtimeBuildMode({ platform: "darwin", arch: "arm64", node: "24.18.1", run })).toEqual({ docker: true });
    run.mockRejectedValueOnce(new Error("missing docker"));
    await expect(runtimeBuildMode({ platform: "darwin", arch: "arm64", node: "24", run })).rejects.toThrow(/start Docker or publish.*Linux.*--local/);
  });
});

describe("electron:cloud runtime use and cleanup", () => {
  const instance = "11111111-2222-4333-8444-555555555555", sha = "c".repeat(64);
  function fixture(plan: Record<string, unknown> = { status: "planned", mode: "dry-run", remove: [], bytes: 0 }) {
    const client = { destroy: vi.fn() };
    const retention = { recordRuntimeUse: vi.fn(async () => {}), devRuntimeRetentionMode: vi.fn((value?: string) => value === "apply" ? "apply" : "dry-run"),
      retainDevRuntimes: vi.fn(async () => plan), removeRuntimeUses: vi.fn(async () => 2) };
    const module = vi.fn(async (name: string) => name === "runtime-retention.js" ? retention : { runtimeStorageClient: vi.fn(() => client) });
    const workspace = { directory: "/fixture/state", state: { instanceId: instance, owner: "a".repeat(24) } }, profile = { storage: { bucket: "zeros-dev-objects" } };
    return { client, retention, module, workspace, profile, write: vi.fn() };
  }
  it("marks this checkout's runtime before planning cleanup, in dry-run unless applied, and keeps the plan for review", async () => {
    const f = fixture();
    await maintainLocalRuntimes(f.workspace, f.profile, "/fixture", sha, { module: f.module, env: {}, write: f.write });
    expect(f.retention.recordRuntimeUse).toHaveBeenCalledWith(f.client, "zeros-dev-objects", sha, { owner: "a".repeat(24), instance });
    expect(f.retention.retainDevRuntimes).toHaveBeenCalledWith(f.client, "zeros-dev-objects", { current: sha, previous: null, mode: "dry-run" });
    expect(f.retention.recordRuntimeUse.mock.invocationCallOrder[0]).toBeLessThan(f.retention.retainDevRuntimes.mock.invocationCallOrder[0]!);
    expect(f.write).toHaveBeenCalledWith("/fixture/state/runtime-retention.json", expect.stringContaining('"status": "planned"'));
    expect(f.client.destroy).toHaveBeenCalledOnce();
    await maintainLocalRuntimes(f.workspace, f.profile, "/fixture", sha, { module: f.module, env: { ZEROS_DEV_RUNTIME_RETENTION: "apply" }, write: f.write });
    expect(f.retention.retainDevRuntimes).toHaveBeenLastCalledWith(f.client, "zeros-dev-objects", { current: sha, previous: null, mode: "apply" });
  });
  it("marks and keeps the previous runtime a wake may still start, ignoring an invalid or repeated one", async () => {
    const f = fixture(), previous = "d".repeat(64);
    await maintainLocalRuntimes(f.workspace, f.profile, "/fixture", sha, { module: f.module, env: {}, write: f.write, previous });
    expect(f.retention.recordRuntimeUse.mock.calls.map(call => call[2])).toEqual([sha, previous]);
    expect(f.retention.retainDevRuntimes).toHaveBeenLastCalledWith(f.client, "zeros-dev-objects", { current: sha, previous, mode: "dry-run" });
    for (const ignored of ["not-a-digest", sha]) {
      const g = fixture();
      await maintainLocalRuntimes(g.workspace, g.profile, "/fixture", sha, { module: g.module, env: {}, write: g.write, previous: ignored });
      expect(g.retention.recordRuntimeUse.mock.calls.map(call => call[2])).toEqual([sha]);
    }
    const h = fixture();
    await markLocalRuntime(h.workspace, h.profile, "/fixture", sha, { module: h.module, previous });
    expect(h.retention.recordRuntimeUse.mock.calls.map(call => call[2])).toEqual([sha, previous]);
  });
  it("plans nothing when the marker cannot be written", async () => {
    const f = fixture(); f.retention.recordRuntimeUse.mockRejectedValue(new Error("synthetic"));
    await expect(maintainLocalRuntimes(f.workspace, f.profile, "/fixture", sha, { module: f.module, env: {}, write: f.write })).rejects.toThrow();
    expect(f.retention.retainDevRuntimes).not.toHaveBeenCalled(); expect(f.client.destroy).toHaveBeenCalledOnce();
  });
  it("refreshes the marker and removes this checkout's markers on reset", async () => {
    const f = fixture();
    await markLocalRuntime(f.workspace, f.profile, "/fixture", sha, { module: f.module });
    expect(f.retention.recordRuntimeUse).toHaveBeenCalledWith(f.client, "zeros-dev-objects", sha, { owner: "a".repeat(24), instance });
    expect(await removeLocalRuntimeUses(f.workspace, f.profile, "/fixture", { module: f.module })).toBe(2);
    expect(f.retention.removeRuntimeUses).toHaveBeenCalledWith(f.client, "zeros-dev-objects", instance);
  });
  it("summarizes each outcome in one line", () => {
    const plan = { remove: [{}, {}], bytes: 666e6, kept: [{ reason: "current" }, { reason: "unmarked" }, { reason: "unmarked" }] };
    expect(runtimeRetentionSummary({ ...plan, status: "planned", mode: "dry-run" })).toMatch(/would remove 2 unused runtimes \(0.7 GB\); set ZEROS_DEV_RUNTIME_RETENTION=apply.* 2 never-marked runtimes are kept\.$/);
    expect(runtimeRetentionSummary({ ...plan, kept: [], status: "deleted", mode: "apply" })).toBe("Worker runtime cleanup removed 2 unused runtimes (0.7 GB).");
    expect(runtimeRetentionSummary({ ...plan, status: "managed", mode: "apply" })).toMatch(/release-managed/);
  });
});

describe("electron:cloud abandoned WorkOS endpoint cleanup", () => {
  const owner = "a".repeat(24), gone = "c".repeat(24), instance = "11111111-2222-4333-8444-555555555555", other = "66666666-7777-4888-9999-aaaaaaaaaaaa";
  const week = 7 * 86_400_000;
  function fixture({ reclaimed = null as string | null, since = new Date(Date.now() - 8 * 86_400_000).toISOString() } = {}) {
    const client = { destroy: vi.fn() }, calls: string[] = [];
    const retention = { webhookReclaimed: vi.fn(async () => reclaimed), clearWebhookReclaim: vi.fn(async () => { calls.push("clear"); }),
      runtimeUseOwners: vi.fn(async () => ({ since, active: [] })), recordWebhookReclaim: vi.fn(async (_c: unknown, _b: string, _t: unknown, id: string) => { calls.push(`reclaim:${id}`); }) };
    const module = vi.fn(async (name: string) => name === "runtime-retention.js" ? retention : { runtimeStorageClient: vi.fn(() => client) });
    const inventory = [{ id: "we_mine", endpoint_url: `https://api-dev-${owner}.zeros.build/auth/workos-webhook?zeros_dev=${instance}`, secret: "synthetic-private-signing-secret" },
      { id: "we_gone", endpoint_url: `https://api-dev-${gone}.zeros.build/auth/workos-webhook?zeros_dev=${other}`, secret: "synthetic-private-signing-secret", status: "enabled" }];
    const request = vi.fn(async (route: string, init?: { method?: string }) => {
      if (route.startsWith("/webhook_endpoints?")) return { data: inventory, list_metadata: {} };
      calls.push(`${init?.method}:${route}`); return null;
    });
    const workspace: any = { directory: "/fixture/state", state: { owner, instanceId: instance, workosWebhook: { id: "we_mine", secret: "synthetic-private-signing-secret" } } };
    const profile = { storage: { bucket: "zeros-dev-objects" }, cloudflare: { domain: "zeros.build" }, workos: { apiKey: "synthetic-private-key" } };
    return { retention, module, request, workspace, profile, calls, client, write: vi.fn(), save: vi.fn() };
  }
  const run = (f: ReturnType<typeof fixture>, env: Record<string, string> = {}) =>
    maintainLocalWebhooks(f.workspace, f.profile, "/fixture", { module: f.module, request: f.request, env, write: f.write, save: f.save });

  it("plans in dry-run by default, never this checkout's endpoint, and keeps no secret in the written plan", async () => {
    const f = fixture(), plan = await run(f);
    expect(plan).toMatchObject({ status: "planned", mode: "dry-run", kept: 1, remove: [{ id: "we_gone", owner: gone }] });
    expect(f.calls).toEqual([]);
    expect(f.write).toHaveBeenCalledWith("/fixture/state/workos-webhook-cleanup.json", expect.any(String));
    expect(JSON.stringify(f.write.mock.calls)).not.toContain("synthetic-private");
    expect(webhookCleanupSummary(plan)).toMatch(/would remove 1 abandoned Dev WorkOS endpoint; set ZEROS_DEV_WEBHOOK_CLEANUP=apply/);
    expect(f.client.destroy).toHaveBeenCalledOnce();
  });
  it("deletes abandoned endpoints only when applied, after recording the reclaim", async () => {
    const f = fixture(); await run(f, { ZEROS_DEV_WEBHOOK_CLEANUP: "apply" });
    expect(f.calls).toEqual(["reclaim:we_gone", "DELETE:/webhook_endpoints/we_gone"]);
    expect(f.retention.recordWebhookReclaim).toHaveBeenCalledWith(f.client, "zeros-dev-objects", { owner: gone, instance: other }, "we_gone");
    const waiting = fixture({ since: new Date(Date.now() - week + 60_000).toISOString() });
    expect(await run(waiting, { ZEROS_DEV_WEBHOOK_CLEANUP: "apply" })).toMatchObject({ status: "waiting" });
    expect(waiting.calls).toEqual([]);
  });
  it("forgets this checkout's receipt when another checkout removed its endpoint, then clears the record", async () => {
    const f = fixture({ reclaimed: "we_mine" }), plan = await run(f);
    expect(f.workspace.state.workosWebhook).toBeUndefined(); expect(f.save).toHaveBeenCalledOnce();
    expect(f.calls[0]).toBe("clear");
    expect(webhookCleanupSummary(plan)).toMatch(/a new one is created now/);
  });
});
