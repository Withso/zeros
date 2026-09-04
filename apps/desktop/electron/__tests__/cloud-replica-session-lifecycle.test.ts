import { describe, expect, it, vi } from "vitest";

import {
  seedCloudReplicaSessionToEngineIfEnabled,
  startCloudReplicaSessionRefresh,
} from "../cloud-replica-session-lifecycle";

describe("cloud replica session lifecycle", () => {
  it("does not seed the engine while the desktop capability is disabled", () => {
    const push = vi.fn(async () => undefined);

    expect(
      seedCloudReplicaSessionToEngineIfEnabled({
        capabilityEnabled: () => false,
        push,
      }),
    ).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("does not install a refresh timer while the desktop capability is disabled", () => {
    const refresh = vi.fn(async () => undefined);
    const schedule = vi.fn();
    const cancel = vi.fn();

    const dispose = startCloudReplicaSessionRefresh({
      capabilityEnabled: () => false,
      refresh,
      schedule,
      cancel,
    });

    expect(schedule).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    dispose();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("preserves explicit session seed and refresh behavior when enabled", () => {
    const push = vi.fn(async () => undefined);
    expect(
      seedCloudReplicaSessionToEngineIfEnabled({
        capabilityEnabled: () => true,
        push,
      }),
    ).toBe(true);
    expect(push).toHaveBeenCalledOnce();

    let tick: (() => void) | undefined;
    const timer = { unref: vi.fn() };
    const schedule = vi.fn((callback: () => void) => {
      tick = callback;
      return timer as unknown as ReturnType<typeof setInterval>;
    });
    const cancel = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const dispose = startCloudReplicaSessionRefresh({
      capabilityEnabled: () => true,
      refresh,
      schedule,
      cancel,
    });

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 45_000);
    expect(timer.unref).toHaveBeenCalledOnce();
    tick?.();
    expect(refresh).toHaveBeenCalledOnce();
    dispose();
    expect(cancel).toHaveBeenCalledWith(timer);
  });
});
