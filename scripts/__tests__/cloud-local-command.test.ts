import { describe, expect, it } from "vitest";
import { cloudLocalCommand } from "../cloud-local.mjs";

const SHA = "a".repeat(64);

describe("pnpm cloud:local", () => {
  it("maps each mode to the local Dev launcher with this branch's runtime pin", () => {
    expect(cloudLocalCommand([], { ZEROS_CLOUD_V2_RUNTIME_SHA256: SHA })).toEqual({ action: "start", args: [], runtime: SHA });
    expect(cloudLocalCommand(["--headless"], {}, SHA)).toEqual({ action: "backend", args: [], runtime: SHA });
    expect(cloudLocalCommand(["--runtime", SHA, "--run-only"], {})).toEqual({ action: "start", args: ["--run-only"], runtime: SHA });
    // Stopping, inspecting and resetting never need a runtime.
    expect(cloudLocalCommand(["--stop"], {})).toEqual({ action: "stop", args: [], runtime: undefined });
    expect(cloudLocalCommand(["--doctor"], {})).toEqual({ action: "doctor", args: [], runtime: undefined });
    expect(cloudLocalCommand(["--reset"], {})).toEqual({ action: "archive", args: [], runtime: undefined });
    expect(cloudLocalCommand(["--reset", "--yes"], {})).toEqual({ action: "archive", args: ["--yes"], runtime: undefined });
    expect(cloudLocalCommand(["--seed"], {})).toEqual({ action: "seed", args: [], runtime: undefined });
  });

  it("refuses a start without a published runtime, unknown flags and conflicting modes", () => {
    expect(() => cloudLocalCommand([], {})).toThrow(/runtime/);
    expect(() => cloudLocalCommand(["--runtime", "not-a-sha"], {})).toThrow(/runtime/);
    expect(() => cloudLocalCommand(["--runtime"], {})).toThrow(/runtime/);
    expect(() => cloudLocalCommand(["--watch"], { ZEROS_CLOUD_V2_RUNTIME_SHA256: SHA })).toThrow(/--watch/);
    expect(() => cloudLocalCommand(["--stop", "--reset"], {})).toThrow(/one of/);
    // Only a reset accepts --yes.
    expect(() => cloudLocalCommand(["--yes"], { ZEROS_CLOUD_V2_RUNTIME_SHA256: SHA })).toThrow(/--yes/);
    expect(() => cloudLocalCommand(["--headless", "--stop"], { ZEROS_CLOUD_V2_RUNTIME_SHA256: SHA })).toThrow(/one of/);
  });
});
