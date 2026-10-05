import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("base-owned computer template helpers", () => {
  it("verifies TCB, credential-free clones, bounded install logs and sanitation", () => {
    const tests = fileURLToPath(
      new URL(
        "../cloud-workspace-validation/runtime-base-v4/tests/test_computer_build.py",
        import.meta.url,
      ),
    );
    const result = spawnSync("python3", [tests], {
      encoding: "utf8",
      timeout: 60_000,
    });
    // Python fixtures use synthetic values only; never expose helper input or
    // captured recipe/provider output through a test failure.
    expect(
      result.status,
      result.stderr.replace(
        /(?:gh[spou]_|github_pat_|condw_|sk[_-])[A-Za-z0-9._+/=-]+/g,
        "[redacted]",
      ),
    ).toBe(0);
  });
});
