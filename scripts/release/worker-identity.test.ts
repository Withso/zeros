import { describe, expect, it, vi } from "vitest";
import { workerExecutionConfig } from "./worker-config";
import { workerIdentityAdapter, WORKER_TUPLE_KEYS } from "./worker-identity";
import { workerEnvironment } from "./worker-test-fixtures";

const env = workerEnvironment(), config = workerExecutionConfig(env).config;
const tuple = { CLOUD_WORKSPACE_PROVIDER: "boat", BOAT_SNAPSHOT_ID: "test-new", BOAT_IMAGE_BUILD_SHA256: "b".repeat(64),
  ZEROS_CLOUD_SOURCE_COMMIT: config.sourceSha, ZEROS_CLOUD_IMAGE_ARCHITECTURE: "linux/amd64", CLOUD_WORKSPACE_STORAGE_MIB: "4096" };
function harness(lost = false, apply = true) {
  let selected: Record<string, string> = { ...tuple, BOAT_SNAPSHOT_ID: "test-old", ZEROS_DEPLOY_ENV: config.channel };
  const providers = { railway: vi.fn(async () => ({ variables: selected })), updateWorkerIdentity: vi.fn(async (next: Record<string, string>) => {
    if (apply) selected = { ...selected, ...next };
    if (lost) throw new Error("synthetic lost tuple response");
  }) };
  return { providers, update: workerIdentityAdapter(config, env, providers as any) };
}
describe("complete worker tuple mutation", () => {
  it("validates every tuple value against the exact committed Boat identity before any provider call", async () => {
    const invalid = { CLOUD_WORKSPACE_PROVIDER: ["daytona"], BOAT_SNAPSHOT_ID: ["test;unsafe", "x".repeat(64)],
      BOAT_IMAGE_BUILD_SHA256: ["bad"], ZEROS_CLOUD_SOURCE_COMMIT: ["c".repeat(40)], ZEROS_CLOUD_IMAGE_ARCHITECTURE: ["linux/arm64"],
      CLOUD_WORKSPACE_STORAGE_MIB: ["0", "-1", "01", "1e3", "1.5", "Infinity", "9007199254740993"] };
    for (const [key, values] of Object.entries(invalid)) for (const value of values) {
      const test = harness(); await expect(test.update({ ...tuple, [key]: value })).rejects.toThrow("tuple");
      expect(test.providers.railway).not.toHaveBeenCalled(); expect(test.providers.updateWorkerIdentity).not.toHaveBeenCalled();
    }
  });
  it("requires all and only the six tuple fields", async () => {
    for (const key of WORKER_TUPLE_KEYS) {
      const partial: Record<string, string> = { ...tuple }; delete partial[key];
      await expect(harness().update(partial)).rejects.toThrow("complete tuple");
    }
    await expect(harness().update({ ...tuple, OTHER: "value" })).rejects.toThrow("complete tuple");
  });
  it("refuses a Railway target from another channel before the tuple mutation", async () => {
    const test = harness();
    test.providers.railway.mockResolvedValue({ variables: { ...tuple, ZEROS_DEPLOY_ENV: "beta" } });
    await expect(test.update(tuple)).rejects.toThrow("channel");
    expect(test.providers.updateWorkerIdentity).not.toHaveBeenCalled();
  });
  it("reconciles a lost atomic write with readback without a second mutation", async () => {
    const test = harness(true); await test.update(tuple);
    expect(test.providers.updateWorkerIdentity).toHaveBeenCalledOnce(); expect(test.providers.railway).toHaveBeenCalledTimes(3);
    await test.update(tuple); expect(test.providers.updateWorkerIdentity).toHaveBeenCalledOnce();
  });
  it("refuses an unconfirmed lost write rather than retrying or authorizing a receipt", async () => {
    const test = harness(true, false); await expect(test.update(tuple)).rejects.toThrow("not confirmed");
    expect(test.providers.updateWorkerIdentity).toHaveBeenCalledOnce();
  });
});
