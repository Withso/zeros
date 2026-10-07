import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseReleaseCanaryService } from "../../apps/control-plane/src/cloud-workspaces/release-canaries";
import { startNativeDevCanary } from "../../apps/control-plane/src/cloud-workspaces/dev-native-canary";
import { RELEASE_WORKER_IMAGES_RETIRED } from "../../apps/control-plane/src/cloud-workspaces/release-worker-retirement";

const token = "synthetic-release-bearer";
const target = { id: "bx_test", attempt: "11111111-1111-4111-8111-111111111111", snapshotId: "retired-worker",
  sourceCommit: "a".repeat(40), buildSha256: "b".repeat(64) };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("retired release native admission", () => {
  it.each(["preflight", "admit"] as const)("refuses authenticated %s before credential/audit access or provider dispatch", async method => {
    const connect = vi.fn(async () => { throw new Error("Credential access is forbidden"); });
    const provider = vi.fn(async () => { throw new Error("Provider access is forbidden"); }); vi.stubGlobal("fetch", provider);
    const service = new DatabaseReleaseCanaryService({ connect } as any, { tokenSha256: createHash("sha256").update(token).digest("hex") } as any);
    await expect(service[method]({ target }, `Bearer ${token}`)).rejects.toMatchObject({ status: 409,
      code: "release_worker_images_retired", message: RELEASE_WORKER_IMAGES_RETIRED });
    expect(connect).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });
  it("keeps bearer authentication before the closed retirement response", async () => {
    const connect = vi.fn(), service = new DatabaseReleaseCanaryService({ connect } as any,
      { tokenSha256: createHash("sha256").update(token).digest("hex") } as any);
    await expect(service.admit({}, "Bearer wrong-token")).rejects.toMatchObject({ status: 401, code: "release_canary_unauthorized" });
    expect(connect).not.toHaveBeenCalled();
  });
  it("refuses native staging without reading input material, commands or upload", async () => {
    const command = vi.fn(), upload = vi.fn(), readInput = vi.fn(() => { throw new Error("Native material must remain unread"); });
    const input = { get material() { return readInput(); } };
    await expect(startNativeDevCanary({ command, upload }, target, input)).rejects.toThrow(RELEASE_WORKER_IMAGES_RETIRED);
    expect(command).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled(); expect(readInput).not.toHaveBeenCalled();
  });
});
