import { describe, expect, it, vi } from "vitest";

import { CloudWorkspaceObjectMaintenanceWorker } from "./object-maintenance.js";

describe("CloudWorkspaceObjectMaintenanceWorker", () => {
  it("schedules rotation, drains bounded work, repairs counts, then collects garbage", async () => {
    const calls: string[] = [];
    let rotations = 0;
    let garbage = 0;
    const maintenance = {
      scheduleKeyRotation: vi.fn(async () => {
        calls.push("schedule");
        return 2;
      }),
      rotateKeyOnce: vi.fn(async () => {
        calls.push("rotate");
        rotations += 1;
        return rotations <= 2;
      }),
      reconcileReferenceCounts: vi.fn(async () => {
        calls.push("reconcile");
        return 1;
      }),
      collectGarbageOnce: vi.fn(async () => {
        calls.push("garbage");
        garbage += 1;
        return garbage <= 1;
      }),
    };
    const worker = new CloudWorkspaceObjectMaintenanceWorker(maintenance, {
      workerId: "test-object-maintenance",
      rotationBatchSize: 10,
      garbageBatchSize: 10,
      garbageGraceMs: 60_000,
    });

    await expect(worker.runOnce()).resolves.toEqual({
      scheduledRotations: 2,
      processedRotations: 2,
      repairedReferenceCounts: 1,
      collectedObjects: 1,
    });
    expect(calls).toEqual([
      "schedule",
      "rotate",
      "rotate",
      "rotate",
      "reconcile",
      "garbage",
      "garbage",
    ]);
    expect(maintenance.rotateKeyOnce).toHaveBeenCalledWith({
      workerId: "test-object-maintenance",
      leaseMs: 60_000,
      maxAttempts: 10,
    });
    expect(maintenance.collectGarbageOnce).toHaveBeenCalledWith(60_000);
  });

  it("never overlaps ticks and waits for the active tick during shutdown", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const maintenance = {
      scheduleKeyRotation: vi.fn(async () => {
        await blocked;
        return 0;
      }),
      rotateKeyOnce: vi.fn(async () => false),
      reconcileReferenceCounts: vi.fn(async () => 0),
      collectGarbageOnce: vi.fn(async () => false),
    };
    const worker = new CloudWorkspaceObjectMaintenanceWorker(maintenance, {
      workerId: "test-object-maintenance-stop",
      intervalMs: 100,
    });
    const stop = worker.start();
    const stopping = stop();

    expect(maintenance.scheduleKeyRotation).toHaveBeenCalledTimes(1);
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(maintenance.scheduleKeyRotation).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe worker and retention bounds", () => {
    const maintenance = {
      scheduleKeyRotation: async () => 0,
      rotateKeyOnce: async () => false,
      reconcileReferenceCounts: async () => 0,
      collectGarbageOnce: async () => false,
    };
    expect(
      () =>
        new CloudWorkspaceObjectMaintenanceWorker(maintenance, {
          workerId: "bad\nidentity",
        }),
    ).toThrow("configuration is invalid");
    expect(
      () =>
        new CloudWorkspaceObjectMaintenanceWorker(maintenance, {
          garbageGraceMs: 59_999,
        }),
    ).toThrow("configuration is invalid");
  });
});
