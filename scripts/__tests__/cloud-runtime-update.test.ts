import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("verifies staging, retained receipt restoration, activation fences and rollback with the protected v4 installer", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", path.resolve(import.meta.dirname,
    "../cloud-workspace-validation/runtime-update/tests")], {
    encoding: "utf8", timeout: 60_000, maxBuffer: 128 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toContain("OK");
  expect(result.status).toBe(0);
}, 65_000);
