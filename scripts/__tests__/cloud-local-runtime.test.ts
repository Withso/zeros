import { describe, expect, it, vi } from "vitest";
import { resolveLocalRuntime, runtimeBuildMode } from "../dev-environment/cloud-local-runtime.mjs";

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
