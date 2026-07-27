// Unit tests for the release version scheme (scripts/compute-version.mjs).
//
// Scheme A (locked): MAJOR.MINOR are manual; PATCH is automatic + contiguous,
// computed as (highest released patch on the line) + 1, floored at the baseline.
// computeVersion is a pure function (baseline + tag list → version string), so
// these run with no git and no fs.

import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs has no type declarations; it exports a plain function.
import { computeVersion } from "../compute-version.mjs";

const base = (major: number, minor: number, patch: number) => ({ major, minor, patch });

describe("computeVersion", () => {
  it("first release on a fresh line = the baseline patch (reset → 0.0.1)", () => {
    expect(computeVersion(base(0, 0, 1), [])).toBe("0.0.1");
  });

  it("increments patch by exactly 1 per release (contiguous)", () => {
    expect(computeVersion(base(0, 0, 1), ["v0.0.1"])).toBe("0.0.2");
    expect(computeVersion(base(0, 0, 1), ["v0.0.1", "v0.0.2"])).toBe("0.0.3");
    expect(computeVersion(base(0, 0, 1), ["v0.0.1", "v0.0.2", "v0.0.3"])).toBe("0.0.4");
  });

  it("stays monotonic across a deleted/gapped tag (never reuses a number)", () => {
    // v0.0.2 was deleted — next is still one past the HIGHEST, not the count.
    expect(computeVersion(base(0, 0, 1), ["v0.0.1", "v0.0.3"])).toBe("0.0.4");
  });

  it("patch is unbounded — no base-100 rollover into the minor", () => {
    const tags = Array.from({ length: 99 }, (_, i) => `v0.0.${i + 1}`); // v0.0.1 … v0.0.99
    expect(computeVersion(base(0, 0, 1), tags)).toBe("0.0.100");
  });

  it("minor/major bumps land on the baseline (.0) on a fresh line", () => {
    expect(computeVersion(base(0, 1, 0), [])).toBe("0.1.0");
    expect(computeVersion(base(1, 0, 0), [])).toBe("1.0.0");
    expect(computeVersion(base(2, 0, 0), [])).toBe("2.0.0");
  });

  it("only counts tags on the SAME major.minor line", () => {
    // Releasing on the 0.1 line ignores the 0.0 line's tags.
    expect(computeVersion(base(0, 1, 0), ["v0.0.9", "v0.0.10"])).toBe("0.1.0");
    expect(computeVersion(base(0, 1, 0), ["v0.1.0", "v0.0.50"])).toBe("0.1.1");
  });

  it("ignores legacy tags from the scrapped line (v0.1.x must not bleed into 0.0.x)", () => {
    const legacy = ["v0.1.76", "v0.1.179"];
    expect(computeVersion(base(0, 0, 1), legacy)).toBe("0.0.1");
  });

  it("does not let v0.1.* swallow v0.10.* (anchored match)", () => {
    expect(computeVersion(base(0, 1, 0), ["v0.10.3", "v0.1.4"])).toBe("0.1.5");
  });

  it("respects a pinned floor above existing tags", () => {
    // `version:set 1.0.5` while only v1.0.1 exists → still 1.0.5.
    expect(computeVersion(base(1, 0, 5), ["v1.0.1"])).toBe("1.0.5");
  });

  it("ignores pre-release / suffixed tags (no plain integer patch)", () => {
    expect(computeVersion(base(0, 0, 1), ["v0.0.1-beta", "v0.0.1-rc.1"])).toBe("0.0.1");
  });
});
