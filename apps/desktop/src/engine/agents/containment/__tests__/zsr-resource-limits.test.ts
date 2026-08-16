import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  ZSR_RESOURCE_LIMITS,
  resourceLimitShell,
} from "../zsr-resource-limits.mjs";

describe("ZSR descendant resource limits", () => {
  it.skipIf(process.platform === "win32")(
    "irreversibly caps process, descriptor, and core-file authority",
    () => {
      const probe = spawnSync(
        "/bin/bash",
        [
          "-c",
          `${resourceLimitShell()} printf '%s|%s|%s' "$(ulimit -H -u)" "$(ulimit -H -n)" "$(ulimit -H -c)"`,
        ],
        { encoding: "utf8" },
      );
      expect(probe.status).toBe(0);
      const [processes, files, core] = probe.stdout.split("|").map(Number);
      expect(processes).toBeGreaterThan(0);
      expect(processes).toBeLessThanOrEqual(ZSR_RESOURCE_LIMITS.processes);
      expect(files).toBeGreaterThan(0);
      expect(files).toBeLessThanOrEqual(ZSR_RESOURCE_LIMITS.openFiles);
      expect(core).toBe(0);
    },
  );

  it("does not interpolate request or environment data into the limit prelude", () => {
    expect(resourceLimitShell()).not.toContain(process.cwd());
    expect(resourceLimitShell()).not.toContain("$HOME");
    expect(resourceLimitShell()).toContain("exit 125");
  });
});
