import { describe, expect, it } from "vitest";

import {
  desktopSignInDeadlineReached,
  desktopSignInExpiryLabel,
  desktopSignInSecondsRemaining,
} from "../desktop-sign-in-expiry";

describe("desktop sign-in expiry", () => {
  it("rounds up so the countdown does not lose a second immediately", () => {
    expect(desktopSignInSecondsRemaining(700_000, 100_001)).toBe(600);
    expect(desktopSignInSecondsRemaining(700_000, 101_000)).toBe(599);
  });

  it("formats the authoritative deadline without announcing every tick", () => {
    expect(desktopSignInExpiryLabel(600)).toBe(
      "Sign-in window expires in 10:00",
    );
    expect(desktopSignInExpiryLabel(61)).toBe("Sign-in window expires in 1:01");
    expect(desktopSignInExpiryLabel(0)).toBe("Sign-in window expiring now");
  });

  it("clamps expired and invalid deadlines to zero", () => {
    expect(desktopSignInSecondsRemaining(99_999, 100_000)).toBe(0);
    expect(desktopSignInSecondsRemaining(Number.NaN, 100_000)).toBe(0);
  });

  it("treats the exact authoritative deadline as expired", () => {
    expect(desktopSignInDeadlineReached(100_000, 99_999)).toBe(false);
    expect(desktopSignInDeadlineReached(100_000, 100_000)).toBe(true);
    expect(desktopSignInDeadlineReached(100_000, 100_001)).toBe(true);
    expect(desktopSignInDeadlineReached(Number.NaN, 100_000)).toBe(true);
  });
});
