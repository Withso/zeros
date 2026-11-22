import { describe, expect, it } from "vitest";
import { readyCopyFailureLine, readyCopySubmodulesLine, readyCopyTriggerLabel } from "../ready-copy-copy";

describe("a build's reason in the project history", () => {
  it("names the submodules switch, which the server stores as a setup change", () => {
    expect(readyCopyTriggerLabel("setup_changed", null, "submodules_changed")).toBe("Submodules setting changed");
    expect(readyCopyTriggerLabel("setup_changed", null)).toBe("Setup changed");
    expect(readyCopyTriggerLabel("setup_changed", null, "something_newer")).toBe("Setup changed");
  });
});

describe("a build's submodules in the project history", () => {
  it("counts them per repository, naming the repository only when there are several", () => {
    expect(readyCopySubmodulesLine({ fetched: 3, skipped: 1 })).toBe("Submodules: 3 fetched, 1 skipped");
    expect(readyCopySubmodulesLine({ fetched: 2, skipped: 0 }, "withso/web")).toBe("withso/web submodules: 2 fetched");
    expect(readyCopySubmodulesLine({ fetched: 0, skipped: 0 })).toBeNull();
    expect(readyCopySubmodulesLine(undefined)).toBeNull();
  });
});

describe("a build's failure in the project history", () => {
  it("says a removed connection or project in plain words, and an unknown reason as a plain line, never its code", () => {
    expect(readyCopyFailureLine({ reason: "connection_removed", detail: null }, 0)).toContain("Its GitHub connection was removed.");
    expect(readyCopyFailureLine({ reason: "project_removed", detail: null }, 0)).toContain("The project was removed.");
    const unknown = readyCopyFailureLine({ reason: "ready_copy_something_newer", detail: null }, 0);
    expect(unknown).toContain("The project could not be built.");
    expect(unknown).not.toContain("ready_copy_something_newer");
  });
});
