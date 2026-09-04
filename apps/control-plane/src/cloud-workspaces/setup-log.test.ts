import { describe, expect, it, vi } from "vitest";

import { sanitizeCloudWorkspaceSetupLog } from "./setup-log.js";
import { boundedCloudWorkspaceSetupLog } from "./setup-worker.js";

describe("cloud workspace setup log boundary", () => {
  it("never persists provider, repository, or setup-command output", () => {
    expect(sanitizeCloudWorkspaceSetupLog("")).toBe("");
    expect(
      sanitizeCloudWorkspaceSetupLog(
        `Bearer zws_${"A".repeat(43)} ghs_repository_secret\ncommand output`,
      ),
    ).toBe("[cloud workspace setup output withheld]");
  });

  it("bounds multibyte output without repeated whole-string scans", () => {
    const maximum = 256 * 1024;
    const input = `${"a".repeat(maximum - 20)}${"é".repeat(30)}`;
    const byteLength = vi.spyOn(Buffer, "byteLength");

    const result = boundedCloudWorkspaceSetupLog(input);

    expect(Buffer.byteLength(result.value, "utf8")).toBeLessThanOrEqual(
      maximum,
    );
    expect(result.value.endsWith("é")).toBe(true);
    expect(result.truncated).toBe(true);
    expect(byteLength.mock.calls.length).toBeLessThanOrEqual(4);
  });
});
