import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { electronCloudCommand } from "../electron-cloud.mjs";

const SHA = "a".repeat(64);

describe("pnpm electron:cloud", () => {
  it("publishes the cloud desktop entry point without a retired command alias", () => {
    const { scripts } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(scripts["electron:cloud"]).toBe("node scripts/electron-cloud.mjs");
    expect(scripts).not.toHaveProperty("cloud:local");
    expect(existsSync(new URL("../../docs/electron-cloud.md", import.meta.url))).toBe(true);
    for (const name of ["local-development", "cloud-workspaces"])
      expect(readFileSync(new URL(`../../docs/${name}.md`, import.meta.url), "utf8")).toContain("electron-cloud.md");
  });
  it("maps each mode to the local Dev launcher with this branch's runtime pin", () => {
    expect(electronCloudCommand([], { ZEROS_CLOUD_V2_RUNTIME_SHA256: SHA })).toEqual({ action: "start", args: [], runtime: SHA });
    expect(electronCloudCommand(["--headless"], {}, SHA)).toEqual({ action: "backend", args: [], runtime: SHA });
    expect(electronCloudCommand(["--runtime", SHA, "--run-only"], {})).toEqual({ action: "start", args: ["--run-only"], runtime: SHA });
    // Stopping, inspecting and resetting never need a runtime.
    expect(electronCloudCommand(["--stop"], {})).toEqual({ action: "stop", args: [], runtime: undefined });
    expect(electronCloudCommand(["--doctor"], {})).toEqual({ action: "doctor", args: [], runtime: undefined });
    expect(electronCloudCommand(["--reset"], {})).toEqual({ action: "archive", args: [], runtime: undefined });
    expect(electronCloudCommand(["--reset", "--yes"], {})).toEqual({ action: "archive", args: ["--yes"], runtime: undefined });
    expect(electronCloudCommand(["--seed"], {})).toEqual({ action: "seed", args: [], runtime: undefined });
  });

  it("refuses a start without a published runtime, unknown flags and conflicting modes", () => {
    expect(() => electronCloudCommand([], {})).toThrow(/runtime/);
    expect(() => electronCloudCommand(["--runtime", "not-a-sha"], {})).toThrow(/runtime/);
    expect(() => electronCloudCommand(["--runtime"], {})).toThrow(/runtime/);
    expect(() => electronCloudCommand(["--watch"], { ZEROS_CLOUD_V2_RUNTIME_SHA256: SHA })).toThrow(/--watch/);
    expect(() => electronCloudCommand(["--stop", "--reset"], {})).toThrow(/one of/);
    // Only a reset accepts --yes.
    expect(() => electronCloudCommand(["--yes"], { ZEROS_CLOUD_V2_RUNTIME_SHA256: SHA })).toThrow(/--yes/);
    expect(() => electronCloudCommand(["--headless", "--stop"], { ZEROS_CLOUD_V2_RUNTIME_SHA256: SHA })).toThrow(/one of/);
  });
});
