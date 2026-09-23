import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENGINE_HEARTBEAT_INTERVAL_MS,
  engineLifecycleRequestsPerMinute,
  MAX_ENGINE_HEARTBEAT_INTERVAL_MS,
  MIN_ENGINE_HEARTBEAT_INTERVAL_MS,
} from "./engine-heartbeat.js";

describe("engine heartbeat cadence", () => {
  it("keeps three beats inside the 90-second lease and inside the engine's accepted range", () => {
    expect(MIN_ENGINE_HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(5_000);
    expect(MAX_ENGINE_HEARTBEAT_INTERVAL_MS * 3).toBeLessThanOrEqual(90_000);
    expect(DEFAULT_ENGINE_HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(MIN_ENGINE_HEARTBEAT_INTERVAL_MS);
    expect(DEFAULT_ENGINE_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(MAX_ENGINE_HEARTBEAT_INTERVAL_MS);
  });

  it("admits 300 engines' registration and heartbeats per address at any cadence", () => {
    expect(engineLifecycleRequestsPerMinute(30_000)).toBe(600);
    expect(engineLifecycleRequestsPerMinute(10_000)).toBe(1_800);
    expect(engineLifecycleRequestsPerMinute(5_000)).toBe(3_600);
    expect(engineLifecycleRequestsPerMinute(7_000)).toBe(2_572);
  });
});
