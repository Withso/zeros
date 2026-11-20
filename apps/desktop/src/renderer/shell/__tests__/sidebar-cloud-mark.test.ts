import { describe, expect, it } from "vitest";
import { cloudMarkState } from "../sidebar-cloud-mark";

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
});
