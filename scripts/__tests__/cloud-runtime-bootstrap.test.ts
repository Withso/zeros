import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("runs the base-owned Python security and recovery suite without root", () => {
  const result = spawnSync("python3", ["-I", "-m", "unittest", "discover", "-s",
    "scripts/cloud-workspace-validation/runtime-base-v4/tests", "-v"], {
    cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 100_000);
