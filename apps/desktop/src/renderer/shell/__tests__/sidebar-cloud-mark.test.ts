import { describe, expect, it } from "vitest";
import { cloudMarkState, showsCloudMark } from "../sidebar-cloud-mark";

describe("sidebar cloud mark", () => {
  it.each([
    ["ready", "running"],
    ["busy", "running"],
    ["provisioning", "starting"],
    ["waking", "starting"],
    ["setting_up", "starting"],
    ["stopping", "stopped"],
    ["stopped", "stopped"],
    ["archived", "stopped"],
    ["failed", "stopped"],
  ] as const)("shows %s as %s", (status, state) => {
    expect(cloudMarkState(status)).toBe(state);
  });

  it("never claims a workspace with no confirmed status is running", () => {
    expect(cloudMarkState(undefined)).toBe("unknown");
    expect(cloudMarkState(null)).toBe("unknown");
  });

  it("shares one trailing slot: an awaiting, unread or draft mark outranks the cloud mark", () => {
    expect(showsCloudMark(true, null)).toBe(true);
    for (const mark of ["question", "unread", "draft"]) expect(showsCloudMark(true, mark)).toBe(false);
    expect(showsCloudMark(false, null)).toBe(false);
  });
});
