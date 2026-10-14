import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CloudBuilderVms } from "./cloud-builder-vm.js";
import type { BuilderVmOperationStore } from "./cloud-builder-vm-store.js";
import { CloudWorkspaceObjectMaintenanceWorker } from "./object-maintenance.js";
import type { RuntimeArtifactStore } from "./runtime-artifact-store.js";
import { RuntimeImageWorker, type RuntimeImageSnapshots } from "./runtime-images.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(Math, "random").mockReturnValue(1);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function objects() {
  return {
    scheduleKeyRotation: vi.fn(async () => 0),
    rotateKeyOnce: vi.fn(async () => false),
    reconcileReferenceCounts: vi.fn(async () => 0),
    collectGarbageOnce: vi.fn(async () => false),
  };
}

function images() {
  return new RuntimeImageWorker({
    pool: {} as pg.Pool,
    enabled: true,
    channel: "alpha",
    mode: "full",
    accountScope: "maintenance-fixture",
    billingOrg: "maintenance-fixture",
    vms: {} as CloudBuilderVms,
    operations: {} as BuilderVmOperationStore,
    artifacts: {} as RuntimeArtifactStore,
    snapshots: {} as RuntimeImageSnapshots,
  });
}

describe("bounded maintenance sweeps", () => {
  it("does not repeat idle runtime-image sweeps every minute", async () => {
    const worker = images();
    const tick = vi.spyOn(worker, "tick").mockResolvedValue(undefined);
    const stop = worker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(tick).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(299_999);
      expect(tick).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(tick).toHaveBeenCalledTimes(2);
    } finally {
      await stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not repeat empty object rotation and garbage scans every minute", async () => {
    const maintenance = objects();
    const stop = new CloudWorkspaceObjectMaintenanceWorker(maintenance).start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(maintenance.scheduleKeyRotation).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(299_999);
      expect(maintenance.scheduleKeyRotation).toHaveBeenCalledOnce();
      expect(maintenance.reconcileReferenceCounts).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(maintenance.scheduleKeyRotation).toHaveBeenCalledTimes(2);
    } finally {
      await stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues full object batches without waiting for an idle sweep", async () => {
    const maintenance = objects();
    maintenance.rotateKeyOnce.mockResolvedValueOnce(true).mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    maintenance.collectGarbageOnce.mockResolvedValueOnce(true).mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const stop = new CloudWorkspaceObjectMaintenanceWorker(maintenance, {
      rotationBatchSize: 2,
      garbageBatchSize: 2,
    }).start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(maintenance.rotateKeyOnce).toHaveBeenCalledTimes(2);
      expect(maintenance.collectGarbageOnce).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(99);
      expect(maintenance.rotateKeyOnce).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(maintenance.rotateKeyOnce).toHaveBeenCalledTimes(4);
      expect(maintenance.collectGarbageOnce).toHaveBeenCalledTimes(4);
      // The second bounded pass exhausted both queues. Return to idle cadence.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(maintenance.reconcileReferenceCounts).toHaveBeenCalledTimes(2);
    } finally {
      await stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds repeated full object batches when a deletion keeps failing", async () => {
    const maintenance = objects();
    // A quarantined object still counts as an attempted collection. A full
    // batch therefore cannot justify an unlimited immediate retry loop.
    maintenance.collectGarbageOnce.mockResolvedValue(true);
    const stop = new CloudWorkspaceObjectMaintenanceWorker(maintenance, {
      garbageBatchSize: 2,
    }).start();
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(maintenance.collectGarbageOnce).toHaveBeenCalledTimes(8);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(maintenance.collectGarbageOnce).toHaveBeenCalledTimes(8);
    } finally {
      await stop();
    }
  });

  it("coalesces runtime registry hints during a sweep and drains before stopping", async () => {
    const worker = images() as RuntimeImageWorker & { notify(): void };
    let release!: () => void;
    const tick = vi.spyOn(worker, "tick").mockResolvedValue(undefined)
      .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const stop = worker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 50; i++) worker.notify();
      await vi.advanceTimersByTimeAsync(1);
      expect(tick).toHaveBeenCalledOnce();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(tick).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await stop();
    }
    worker.notify();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
