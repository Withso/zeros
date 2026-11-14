import { execFileSync, spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { readRuntimeInstallTimings, runtimeTimingScript } from "./runtime-timing.js";

it("logs only bounded numeric phases, excluding arbitrary provider output", () => {
  expect(readRuntimeInstallTimings([
    "zeros-runtime-timing download 123 ok", "zeros-runtime-timing verify 4 failed",
    "https://private.example.test/?secret=synthetic", "zeros-runtime-timing private 1 ok",
    "zeros-runtime-timing download -1 ok", "zeros-runtime-timing unpack 3600001 ok",
    "zeros-runtime-timing activate 1 ok token=synthetic", "zeros-runtime-timing lock 1e3 ok",
  ].join("\n"))).toEqual([
    { phase: "download", durationMs: 123, result: "ok" }, { phase: "verify", durationMs: 4, result: "failed" },
  ]);
  expect(readRuntimeInstallTimings("x".repeat(65_537))).toEqual([]);
  expect(readRuntimeInstallTimings("zeros-runtime-timing cache 0 ok\n".repeat(100))).toHaveLength(32);
});

it("preserves the first failing phase and exit code through cleanup", () => {
  const result = spawnSync("bash", ["-c", ["set -eu", ...runtimeTimingScript,
    "runtime_begin download", "runtime_begin verify", "exit 17"].join("\n")], { encoding: "utf8" });
  expect(result.status).toBe(17);
  expect(readRuntimeInstallTimings(result.stdout)).toEqual([
    { phase: "download", durationMs: expect.any(Number), result: "ok" },
    { phase: "verify", durationMs: expect.any(Number), result: "failed" },
  ]);
});

it("records a completed cached check once without inventing download phases", () => {
  const output = execFileSync("bash", ["-c", [...runtimeTimingScript, "runtime_begin cache", "exit 0"].join("\n")], { encoding: "utf8" });
  expect(readRuntimeInstallTimings(output)).toEqual([{ phase: "cache", durationMs: expect.any(Number), result: "ok" }]);
});
