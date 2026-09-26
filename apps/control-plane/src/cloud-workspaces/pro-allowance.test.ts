import { describe, expect, it } from "vitest";
import { proMonthlyPeriod } from "./pro-allowance.js";

describe("Pro allowance UTC periods", () => {
  it.each([
    [
      "2025-01-31T12:34:56.789Z",
      "2025-02-28T12:34:56.789Z",
      "2025-02-28T12:34:56.789Z",
      "2025-03-31T12:34:56.789Z",
    ],
    [
      "2024-01-31T12:00:00.000Z",
      "2024-02-29T11:59:59.999Z",
      "2024-01-31T12:00:00.000Z",
      "2024-02-29T12:00:00.000Z",
    ],
    [
      "2024-02-29T00:00:00.000Z",
      "2025-03-01T00:00:00.000Z",
      "2025-02-28T00:00:00.000Z",
      "2025-03-29T00:00:00.000Z",
    ],
    [
      "2025-12-31T23:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-01-31T23:00:00.000Z",
      "2026-02-28T23:00:00.000Z",
    ],
  ])("retains the original anchor %s at %s", (anchor, at, start, end) => {
    const period = proMonthlyPeriod(new Date(anchor), new Date(at));
    expect(period?.startsAt.toISOString()).toBe(start);
    expect(period?.endsAt.toISOString()).toBe(end);
  });
  it("does not issue before activation", () =>
    expect(
      proMonthlyPeriod(new Date("2025-02-01Z"), new Date("2025-01-31Z")),
    ).toBeNull());
});
