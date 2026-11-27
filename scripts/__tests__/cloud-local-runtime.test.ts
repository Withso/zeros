import { describe, expect, it, vi } from "vitest";
import { maintainLocalRuntimes, markLocalRuntime, removeLocalRuntimeUses, resolveLocalRuntime, runtimeBuildMode,
  runtimeRetentionSummary } from "../dev-environment/cloud-local-runtime.mjs";

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
    const workspace = { directory: "/fixture/state", state: { instanceId: instance } }, profile = { storage: { bucket: "zeros-dev-objects" } };
    return { client, retention, module, workspace, profile, write: vi.fn() };
  }
  it("marks this checkout's runtime before planning cleanup, in dry-run unless applied, and keeps the plan for review", async () => {
    const f = fixture();
    await maintainLocalRuntimes(f.workspace, f.profile, "/fixture", sha, { module: f.module, env: {}, write: f.write });
    expect(f.retention.recordRuntimeUse).toHaveBeenCalledWith(f.client, "zeros-dev-objects", sha, instance);
    expect(f.retention.retainDevRuntimes).toHaveBeenCalledWith(f.client, "zeros-dev-objects", { current: sha, mode: "dry-run" });
    expect(f.retention.recordRuntimeUse.mock.invocationCallOrder[0]).toBeLessThan(f.retention.retainDevRuntimes.mock.invocationCallOrder[0]!);
    expect(f.write).toHaveBeenCalledWith("/fixture/state/runtime-retention.json", expect.stringContaining('"status": "planned"'));
    expect(f.client.destroy).toHaveBeenCalledOnce();
    await maintainLocalRuntimes(f.workspace, f.profile, "/fixture", sha, { module: f.module, env: { ZEROS_DEV_RUNTIME_RETENTION: "apply" }, write: f.write });
    expect(f.retention.retainDevRuntimes).toHaveBeenLastCalledWith(f.client, "zeros-dev-objects", { current: sha, mode: "apply" });
  });
  it("plans nothing when the marker cannot be written", async () => {
    const f = fixture(); f.retention.recordRuntimeUse.mockRejectedValue(new Error("synthetic"));
    await expect(maintainLocalRuntimes(f.workspace, f.profile, "/fixture", sha, { module: f.module, env: {}, write: f.write })).rejects.toThrow();
    expect(f.retention.retainDevRuntimes).not.toHaveBeenCalled(); expect(f.client.destroy).toHaveBeenCalledOnce();
  });
  it("refreshes the marker and removes this checkout's markers on reset", async () => {
    const f = fixture();
    await markLocalRuntime(f.workspace, f.profile, "/fixture", sha, { module: f.module });
    expect(f.retention.recordRuntimeUse).toHaveBeenCalledWith(f.client, "zeros-dev-objects", sha, instance);
    expect(await removeLocalRuntimeUses(f.workspace, f.profile, "/fixture", { module: f.module })).toBe(2);
    expect(f.retention.removeRuntimeUses).toHaveBeenCalledWith(f.client, "zeros-dev-objects", instance);
  });
  it("summarizes each outcome in one line", () => {
    const plan = { remove: [{}, {}], bytes: 666e6, deletesFrom: "2026-12-04T00:00:00.000Z" };
    expect(runtimeRetentionSummary({ ...plan, status: "planned", mode: "dry-run" })).toMatch(/would remove 2 unused runtimes \(0.7 GB\); set ZEROS_DEV_RUNTIME_RETENTION=apply/);
    expect(runtimeRetentionSummary({ ...plan, status: "waiting", mode: "apply" })).toMatch(/waits for use markers until 2026-12-04/);
    expect(runtimeRetentionSummary({ ...plan, status: "deleted", mode: "apply" })).toBe("Worker runtime cleanup removed 2 unused runtimes (0.7 GB).");
    expect(runtimeRetentionSummary({ ...plan, status: "managed", mode: "apply" })).toMatch(/release-managed/);
  });
});
