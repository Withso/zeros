import { describe, expect, it } from "vitest";
import { CLOUD_FOCUS_PING_MS, cloudFocusPingDue } from "../use-cloud-focus-activity";

describe("cloud focus activity", () => {
  const base = { visible: true, focused: true, status: "ready", lastPingAt: 0, now: CLOUD_FOCUS_PING_MS };
  it("pings for a focused, visible, running workspace at most once a minute", () => {
    expect(cloudFocusPingDue(base)).toBe(true);
    expect(cloudFocusPingDue({ ...base, status: "busy" })).toBe(true);
    expect(cloudFocusPingDue({ ...base, now: CLOUD_FOCUS_PING_MS - 1 })).toBe(false);
  });
  it("never pings a hidden or blurred window, or a VM that is not running", () => {
    expect(cloudFocusPingDue({ ...base, visible: false })).toBe(false);
    expect(cloudFocusPingDue({ ...base, focused: false })).toBe(false);
    for (const status of ["stopped", "starting", "archived", undefined]) expect(cloudFocusPingDue({ ...base, status })).toBe(false);
  });
});
