import { describe, expect, it, vi } from "vitest";
import { BoatComputerImageDriver } from "./computer-image-boat.js";
import type { BoatApiClient } from "./boat-client.js";
import type { ComputerImage } from "./computer-image.js";

const builder = "bx_23456789",
  verifier = "bx_abcdefgh",
  wallet = "team_fixture";
const image = {
  id: "11111111-1111-4111-8111-111111111111",
  snapshot_name: `zeros-org-${"1".repeat(32)}`,
  snapshot_id: "snapshot_1",
  builder_id: builder,
  verifier_id: verifier,
  base_image_ref: `boat:release-base@sha256:${"a".repeat(64)}`,
  base_source_commit: "b".repeat(40),
  recipe_sha256: "c".repeat(64),
  profile: { cpuMillicores: 4000 },
  created_at: new Date(),
  capture_dispatched_at: null,
  snapshot_deletion_requested_at: null,
} as unknown as ComputerImage;
const snap = {
  name: image.snapshot_name,
  snapshotId: image.snapshot_id,
  sourceSandboxId: builder,
  status: "ready",
};
function fixture() {
  const request = vi.fn();
  return {
    request,
    driver: new BoatComputerImageDriver(
      { request } as unknown as BoatApiClient,
      wallet,
    ),
  };
}
describe("Boat image wire adapter (fake provider only)", () => {
  it("allocates the dedicated builder with an empty environment and bounded lease", async () => {
    const { request, driver } = fixture();
    request.mockResolvedValue({ sandbox: { id: builder } });
    expect(await driver.create(image, "builder", async () => {})).toBe(builder);
    expect(request).toHaveBeenCalledWith("/sandboxes", {
      method: "POST",
      idempotencyKey: `computer-image.${image.id}.builder`,
      body: {
        from: "release-base",
        type: "default",
        ttlSeconds: 1800,
        noEnv: true,
        env: {},
      },
    });
  });
  it("refuses a swapped named snapshot before creating the verification clone", async () => {
    const { request, driver } = fixture();
    request.mockResolvedValue({
      snapshot: { ...snap, snapshotId: "replaced" },
    });
    await expect(driver.create(image, "verifier", async () => {})).rejects.toMatchObject({
      code: "image_snapshot_identity_mismatch",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not admit a sandbox charged to another wallet", async () => {
    const { request, driver } = fixture();
    request.mockResolvedValue({
      sandbox: { id: builder, state: "running", team: { id: "other" } },
    });
    await expect(driver.ready(builder)).rejects.toMatchObject({
      code: "image_billing_scope_mismatch",
    });
  });
  it("never replays a create outside the provider's idempotency retention", async () => {
    const { request, driver } = fixture();
    await expect(
      driver.create(
        { ...image, created_at: new Date(Date.now() - 24 * 3600000) },
        "builder",
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "image_create_outcome_unknown" });
    expect(request).not.toHaveBeenCalled();
  });
  it("persists a deletion receipt before polling, and resumes using that receipt", async () => {
    const { request, driver } = fixture();
    const operation = `bdop_${"a".repeat(32)}`,
      persist = vi.fn(async () => {});
    request
      .mockResolvedValueOnce({
        operation: { id: operation, targetId: builder },
      })
      .mockResolvedValueOnce({
        operation: {
          id: operation,
          targetId: builder,
          status: "processing",
          completedAt: null,
        },
      });
    expect(await driver.removeSandbox(builder, null, persist)).toBe(false);
    expect(persist).toHaveBeenCalledWith(operation);
    request.mockReset();
    request.mockResolvedValue({
      operation: {
        id: operation,
        targetId: builder,
        status: "completed",
        completedAt: new Date().toISOString(),
      },
    });
    expect(await driver.removeSandbox(builder, operation, persist)).toBe(true);
    expect(request).toHaveBeenCalledWith(`/deletion-operations/${operation}`);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("never deletes release snapshots or an org snapshot with a different source", async () => {
    const { request, driver } = fixture();
    await expect(
      driver.removeSnapshot(
        { ...image, snapshot_name: "release-base" },
        async () => {},
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue({
      snapshot: { ...snap, sourceSandboxId: verifier },
    });
    await expect(
      driver.removeSnapshot(image, async () => {}),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("refuses deletion of an org snapshot promoted to the configured base", async () => {
    const request = vi.fn().mockResolvedValue({ snapshot: snap });
    const driver = new BoatComputerImageDriver({ request } as unknown as BoatApiClient, wallet, [image.snapshot_name]);
    await expect(driver.removeSnapshot(image, async () => {})).rejects.toMatchObject({ code: "image_snapshot_protected" });
    expect(request).not.toHaveBeenCalled();
  });
  it("refuses builder compute after the hosted Dev admission expires", async () => {
    const { request, driver } = fixture();
    request.mockResolvedValue({ sandbox: { id: builder } });
    vi.stubEnv("ZEROS_DEV_ENVIRONMENT", "hosted");
    vi.stubEnv("ZEROS_DEV_ADMISSION_EXPIRES_AT", new Date(Date.now() - 60000).toISOString());
    try {
      await expect(driver.create(image, "builder", async () => {})).rejects.toMatchObject({ code: "image_build_admission_expired" });
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
