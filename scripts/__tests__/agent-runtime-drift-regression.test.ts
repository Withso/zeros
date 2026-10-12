import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("runtime drift command", () => {
  it("does not announce all pins current when every registry lookup failed", () => {
    const preload =
      "data:text/javascript," +
      encodeURIComponent(
        "globalThis.fetch = async () => new Response(null, { status: 503 });",
      );
    const stdout = execFileSync(
      process.execPath,
      ["--import", preload, "scripts/check-runtime-pins.mjs", "--drift"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      },
    );
    expect(stdout).toContain("Runtime drift incomplete: 3 unavailable");
    expect(stdout).not.toContain("All 3 runtime pins are at latest");
  });
});
