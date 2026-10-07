import { describe, expect, it, vi } from "vitest";
import { BoatApiClient } from "./boat-client.js";
import { CloudProviderError } from "./provider.js";
import { BoatComputerRetirementDriver } from "./computer-retirement-boat.js";
import type { RetiredComputerImage } from "./computer-retirement.js";

const builder = "bx_23456789",
  wallet = "team_fixture",
  operation = `bdop_${"a".repeat(32)}`;
const image: RetiredComputerImage = {
  id: "11111111-1111-4111-8111-111111111111",
  org_id: "22222222-2222-4222-8222-222222222222",
  account_scope: "fixture",
  snapshot_name: "zeros-org-11111111111141118111111111111111",
  snapshot_id: "snapshot_1",
  builder_id: builder,
  verifier_id: null,
  state: "retiring",
  created_at: new Date(),
  builder_dispatched_at: new Date(),
  verifier_dispatched_at: null,
  builder_deleted: false,
  verifier_deleted: false,
  builder_deletion_operation: null,
  verifier_deletion_operation: null,
  capture_dispatched_at: new Date(),
  snapshot_deletion_requested_at: null,
};
const snapshot = {
  name: image.snapshot_name,
  snapshotId: image.snapshot_id,
  sourceSandboxId: builder,
  status: "ready",
};
const absent = () =>
  new CloudProviderError(
    "provider_not_found",
    "Synthetic absent resource",
    false,
  );
function fixture(protectedSnapshots: string[] = []) {
  const request = vi.fn(),
    admission = { release: vi.fn(async () => {}) };
  return {
    request,
    admission,
    driver: new BoatComputerRetirementDriver(
      { request } as unknown as BoatApiClient,
      wallet,
      protectedSnapshots,
      admission,
    ),
  };
}
describe("Boat historical retirement wire adapter", () => {
  it("persists the exact deletion receipt before polling and resumes without another DELETE", async () => {
    const { request, driver } = fixture(),
      persist = vi.fn(async () => {});
    request
      .mockResolvedValueOnce({ sandbox: { id: builder, team: { id: wallet } } })
      .mockResolvedValueOnce({
        operation: { id: operation, targetId: builder },
      })
      .mockImplementationOnce(async () => {
        expect(persist).toHaveBeenCalledWith(operation);
        return {
          operation: {
            id: operation,
            targetId: builder,
            status: "processing",
            completedAt: null,
          },
        };
      });
    expect(await driver.removeSandbox(builder, null, persist)).toBe(false);
    request
      .mockReset()
      .mockResolvedValue({
        operation: {
          id: operation,
          targetId: builder,
          status: "completed",
          completedAt: new Date().toISOString(),
        },
      });
    expect(await driver.removeSandbox(builder, operation, persist)).toBe(true);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `/deletion-operations/${operation}`,
    );
  });
  it("recovers a lost DELETE reply through deletion-only replay and requires a completed receipt", async () => {
    const { request, driver } = fixture();
    request
      .mockRejectedValueOnce(absent())
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
    expect(await driver.removeSandbox(builder, null, async () => {})).toBe(
      false,
    );
    expect(request).toHaveBeenCalledWith(`/sandboxes/${builder}`, {
      method: "DELETE",
      confirmDelete: builder,
    });
    expect(
      request.mock.calls.every(
        ([, options]) => !options || options.method === "DELETE",
      ),
    ).toBe(true);
  });
  it.each(["wallet", "resource"])(
    "rejects a mismatched %s before deletion",
    async (mismatch) => {
      const { request, driver } = fixture();
      request.mockResolvedValue({
        sandbox: {
          id: mismatch === "resource" ? "bx_3456789A" : builder,
          team: { id: mismatch === "wallet" ? "foreign" : wallet },
        },
      });
      await expect(
        driver.removeSandbox(builder, null, async () => {}),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["bdop_invalid", operation])(
    "requires a receipt for the exact resource: %s",
    async (receipt) => {
      const { request, driver } = fixture();
      request.mockResolvedValue({
        operation: {
          id: receipt,
          targetId: "bx_3456789A",
          status: "completed",
          completedAt: new Date().toISOString(),
        },
      });
      await expect(
        driver.removeSandbox(builder, receipt, async () => {}),
      ).rejects.toThrow();
    },
  );
  it.each(["name", "source", "immutable id"])(
    "never deletes a swapped snapshot %s",
    async (mismatch) => {
      const { request, driver } = fixture();
      request.mockResolvedValue({
        snapshot: {
          ...snapshot,
          ...(mismatch === "name"
            ? { name: "other" }
            : mismatch === "source"
              ? { sourceSandboxId: "bx_3456789A" }
              : { snapshotId: "other" }),
        },
      });
      await expect(
        driver.removeSnapshot(image, async () => {}),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps configured release/base snapshots protected before any provider request", async () => {
    const { request, driver } = fixture([image.snapshot_name]);
    await expect(driver.removeSnapshot(image, async () => {})).rejects.toThrow(
      "protected",
    );
    await expect(
      driver.removeSnapshot(
        { ...image, snapshot_name: "release-base" },
        async () => {},
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("does not delete a pending capture", async () => {
    const { request, driver } = fixture(),
      persist = vi.fn();
    request.mockResolvedValue({
      snapshot: { ...snapshot, status: "creating" },
    });
    expect(await driver.removeSnapshot(image, persist)).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("persists snapshot deletion intent before DELETE and requires observed absence", async () => {
    const { request, driver } = fixture(),
      persist = vi.fn(async () => {});
    request
      .mockResolvedValueOnce({ snapshot })
      .mockImplementationOnce(async () => {
        expect(persist).toHaveBeenCalledOnce();
        return {};
      })
      .mockRejectedValueOnce(absent());
    expect(await driver.removeSnapshot(image, persist)).toBe(true);
    expect(request).toHaveBeenCalledWith(
      `/named-snapshots/${image.snapshot_name}`,
      { method: "DELETE", confirmDelete: image.snapshot_name },
    );
  });
  it("does not use bare absence as proof for an unjournaled capture deletion", async () => {
    const { request, driver } = fixture();
    request.mockRejectedValue(absent());
    expect(await driver.removeSnapshot(image, async () => {})).toBe(false);
    expect(
      await driver.removeSnapshot(
        { ...image, snapshot_deletion_requested_at: new Date() },
        async () => {},
      ),
    ).toBe(true);
  });
  it("keeps uncertain admission reserved when the shared ledger is unavailable", async () => {
    const request = vi.fn(),
      driver = new BoatComputerRetirementDriver(
        { request } as unknown as BoatApiClient,
        wallet,
      );
    const unstarted = {
      ...image,
      builder_id: null,
      snapshot_id: null,
      builder_dispatched_at: null,
      capture_dispatched_at: null,
    };
    await expect(
      driver.releaseAdmission(unstarted, {
        computeDeleted: true,
        snapshotDeleted: true,
      }),
    ).resolves.toBeUndefined();
    await expect(
      driver.releaseAdmission(image, {
        computeDeleted: true,
        snapshotDeleted: false,
      }),
    ).rejects.toThrow("pending");
    expect(request).not.toHaveBeenCalled();
  });
});
