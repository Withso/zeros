import { describe, expect, it } from "vitest";
import { createEngineHealthActivityTracker } from "../engine-health";

const heartbeat = {
  type: "engine.heartbeat",
  instance: "owned-boot",
  sequence: 0,
  activeRequests: 1,
  activeTurns: 0,
};

describe("owned engine activity", () => {
  it("tracks private work heartbeats separately from ordinary output", () => {
    let now = 100;
    const activity = createEngineHealthActivityTracker(() => now);
    expect(activity.recordHeartbeat(heartbeat, "owned-boot")).toBe(true);
    now = 200;
    activity.recordOutput();
    expect(activity.snapshot()).toEqual({
      lastOutputAt: 200,
      lastHeartbeatAt: 100,
      activeWork: true,
    });
  });

  it("rejects other generations and malformed work counters", () => {
    const activity = createEngineHealthActivityTracker(() => 100);
    for (const value of [
      null,
      { ...heartbeat, instance: "other-boot" },
      { ...heartbeat, type: "other" },
      { ...heartbeat, activeRequests: -1 },
      { ...heartbeat, activeRequests: 0.5 },
      { ...heartbeat, activeTurns: "1" },
      { ...heartbeat, activeTurns: Infinity },
      { ...heartbeat, sequence: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(activity.recordHeartbeat(value, "owned-boot")).toBe(false);
    }
    expect(activity.recordHeartbeat({ ...heartbeat, instance: "" }, "")).toBe(
      false,
    );
    expect(activity.snapshot()).toEqual({
      lastOutputAt: null,
      lastHeartbeatAt: null,
      activeWork: false,
    });
  });

  it("cannot refresh an abandoned heartbeat by replaying an old sequence", () => {
    let now = 100;
    const activity = createEngineHealthActivityTracker(() => now);
    activity.recordHeartbeat({ ...heartbeat, sequence: 2 }, "owned-boot");
    now = 1000;
    expect(
      activity.recordHeartbeat({ ...heartbeat, sequence: 2 }, "owned-boot"),
    ).toBe(false);
    expect(
      activity.recordHeartbeat({ ...heartbeat, sequence: 1 }, "owned-boot"),
    ).toBe(false);
    expect(activity.snapshot().lastHeartbeatAt).toBe(100);
    expect(
      activity.recordHeartbeat({ ...heartbeat, sequence: 3 }, "owned-boot"),
    ).toBe(true);
    expect(activity.snapshot().lastHeartbeatAt).toBe(1000);
  });

  it("observes outstanding turns and their settlement without relying on logs", () => {
    const activity = createEngineHealthActivityTracker(() => 100);
    activity.recordHeartbeat(
      { ...heartbeat, activeRequests: 0, activeTurns: 1 },
      "owned-boot",
    );
    expect(activity.snapshot().activeWork).toBe(true);
    activity.recordHeartbeat(
      { ...heartbeat, sequence: 1, activeRequests: 0 },
      "owned-boot",
    );
    expect(activity.snapshot().activeWork).toBe(false);
  });

  it("does not transfer a previous child's activity into a replacement", () => {
    const old = createEngineHealthActivityTracker(() => 100);
    old.recordHeartbeat(heartbeat, "owned-boot");
    old.recordOutput();
    const replacement = createEngineHealthActivityTracker(() => 200);
    expect(replacement.snapshot()).toEqual({
      lastOutputAt: null,
      lastHeartbeatAt: null,
      activeWork: false,
    });
  });
});
