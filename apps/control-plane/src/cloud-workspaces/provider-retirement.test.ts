import { describe, expect, it, vi } from "vitest";
import { isSupportedCloudWorkspaceProviderBinding } from "./provider.js";
import { readRuntimeStatus, readRuntimeReleaseIdentity } from "./runtime-publication-routes.js";

// Historical row values are deliberately tested without registering an adapter.
const retiredProvider = "daytona";

function catalogPool() {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FROM cloud_runtime_base_images")
    ? [{ provider: retiredProvider, base_image_id: "retired-base", base_compatibility_id: "retired-contract" }] : [] }));
  return { query, pool: { connect: vi.fn(async () => ({ query, release: vi.fn() })) } as never };
}

describe("retired provider read boundaries", () => {
  it.each([
    { provider: retiredProvider }, { provider: "boat", credentialSource: "delegated" },
    { provider: "boat", credentialSource: retiredProvider }, { provider: "boat", sandboxClass: retiredProvider },
    { provider: "boat", sandboxClass: "linux-vm" },
  ])("returns a typed unsupported decision for persisted binding %j", binding => {
    expect(isSupportedCloudWorkspaceProviderBinding(binding)).toBe(false);
  });

  it("accepts the supported hosted Boat binding", () => {
    expect(isSupportedCloudWorkspaceProviderBinding({ provider: "boat", credentialSource: "hosted", sandboxClass: null })).toBe(true);
  });

  it("keeps the catalog readable while excluding retired bases", async () => {
    const { pool, query } = catalogPool();
    await expect(readRuntimeStatus(pool, "alpha")).resolves.toMatchObject({ bases: [] });
    expect(query.mock.calls.find(([sql]) => sql.includes("FROM cloud_runtime_base_images"))?.[0]).toContain("base.provider='boat'");
  });

  it("does not publish a retired base as the latest approved release identity", async () => {
    const { pool } = catalogPool();
    await expect(readRuntimeReleaseIdentity(pool, "v4")).resolves.toMatchObject({ newestApprovedBase: null });
  });
});
