import { describe, expect, it } from "vitest";

import {
  formatAdmissionFailures,
  parseAdmissionCopies,
} from "../agent-smoke-options.mjs";

describe("agent smoke options", () => {
  it("defaults to one admission and accepts bounded concurrency", () => {
    expect(parseAdmissionCopies([])).toBe(1);
    expect(parseAdmissionCopies(["--admission-copies", "2"])).toBe(2);
    expect(parseAdmissionCopies(["--admission-copies", "4"])).toBe(4);
  });

  it("rejects missing, non-integer, zero, and unbounded copies", () => {
    for (const argv of [
      ["--admission-copies"],
      ["--admission-copies", "two"],
      ["--admission-copies", "0"],
      ["--admission-copies", "5"],
      ["--admission-copies", "2.5"],
    ]) {
      expect(() => parseAdmissionCopies(argv)).toThrow(
        "--admission-copies requires an integer from 1 to 4",
      );
    }
  });

  it("reports distinct admission causes without exposing credential-shaped values", () => {
    const detail = formatAdmissionFailures(
      [
        new Error(
          "Claude OAuth refresh was rejected; refresh_token=private-refresh-value",
        ),
        new Error(
          "Claude OAuth refresh was rejected; refresh_token=private-refresh-value",
        ),
        new Error("sandbox process-domain proof failed"),
      ],
      3,
    );

    expect(detail).toContain("3/3 concurrent admission(s) failed");
    expect(detail).toContain("Claude OAuth refresh was rejected");
    expect(detail).toContain("sandbox process-domain proof failed");
    expect(detail).toContain("refresh_token=[redacted]");
    expect(detail).not.toContain("private-refresh-value");
    expect(detail.match(/Claude OAuth refresh was rejected/g)).toHaveLength(1);
  });
});
