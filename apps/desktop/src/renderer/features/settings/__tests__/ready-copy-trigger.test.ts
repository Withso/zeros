import { describe, expect, it } from "vitest";
import { readyCopyTriggerLabel } from "../ready-copy-copy";

describe("a build's reason in the project history", () => {
  it("names the submodules switch, which the server stores as a setup change", () => {
    expect(readyCopyTriggerLabel("setup_changed", null, "submodules_changed")).toBe("Submodules setting changed");
    expect(readyCopyTriggerLabel("setup_changed", null)).toBe("Setup changed");
    expect(readyCopyTriggerLabel("setup_changed", null, "something_newer")).toBe("Setup changed");
  });
});
