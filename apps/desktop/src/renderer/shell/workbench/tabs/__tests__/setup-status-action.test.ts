import { describe, expect, it } from "vitest";
import { setupStatusAction } from "../setup-status-action";

describe("setupStatusAction", () => {
  it("offers Stop while a run is live, with or without output", () => {
    expect(setupStatusAction({ state: "running", hasLog: false, hasCommand: true })).toBe("stop");
    expect(setupStatusAction({ state: "running", hasLog: true, hasCommand: false })).toBe("stop");
  });

  it("offers Rerun on a finished log when the repository has a setup command", () => {
    expect(setupStatusAction({ state: "passed", hasLog: true, hasCommand: true })).toBe("rerun");
  });

  it("offers no Rerun on a log written without a setup command (the submodule step)", () => {
    expect(setupStatusAction({ state: "passed", hasLog: true, hasCommand: false })).toBeNull();
    expect(setupStatusAction({ state: "failed", hasLog: true, hasCommand: undefined })).toBeNull();
  });

  it("shows nothing before there is a log", () => {
    expect(setupStatusAction({ state: null, hasLog: false, hasCommand: true })).toBeNull();
  });
});
