import { describe, it, expect } from "vitest";
import { formatCompactAge } from "../format-age";

const NOW = 1_700_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

describe("formatCompactAge", () => {
  it("renders sub-second as 'now'", () => {
    expect(formatCompactAge(NOW - 500, NOW)).toBe("now");
    expect(formatCompactAge(NOW, NOW)).toBe("now");
  });

  it("renders seconds", () => {
    expect(formatCompactAge(NOW - 6 * SEC, NOW)).toBe("6s");
    expect(formatCompactAge(NOW - 59 * SEC, NOW)).toBe("59s");
  });

  it("renders minutes", () => {
    expect(formatCompactAge(NOW - 6 * MIN, NOW)).toBe("6m");
    expect(formatCompactAge(NOW - 59 * MIN, NOW)).toBe("59m");
  });

  it("renders hours", () => {
    expect(formatCompactAge(NOW - 6 * HOUR, NOW)).toBe("6h");
    expect(formatCompactAge(NOW - 23 * HOUR, NOW)).toBe("23h");
  });

  it("renders days", () => {
    expect(formatCompactAge(NOW - 6 * DAY, NOW)).toBe("6d");
    expect(formatCompactAge(NOW - 364 * DAY, NOW)).toBe("364d");
  });

  it("renders years", () => {
    expect(formatCompactAge(NOW - 6 * YEAR, NOW)).toBe("6y");
  });

  it("clamps future timestamps (clock skew) to 'now'", () => {
    expect(formatCompactAge(NOW + 10 * SEC, NOW)).toBe("now");
  });

  it("returns empty string for missing/invalid timestamps", () => {
    expect(formatCompactAge(0, NOW)).toBe("");
    expect(formatCompactAge(Number.NaN, NOW)).toBe("");
  });
});
