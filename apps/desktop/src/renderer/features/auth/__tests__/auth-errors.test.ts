import { afterEach, describe, it, expect, vi } from "vitest";
import {
  friendlyAuthError,
  safeBrowserSignInStartError,
  workOSSignInFailureMessage,
} from "../auth-errors";

afterEach(() => vi.restoreAllMocks());

describe("friendlyAuthError", () => {
  it("maps rate-limit errors to calm copy", () => {
    expect(friendlyAuthError("Email rate limit exceeded")).toMatch(/too many attempts/i);
    expect(friendlyAuthError("For security purposes, you can only request this after 47 seconds")).toMatch(
      /too many attempts/i,
    );
  });

  it("maps expired/invalid/token errors to one generic 'incorrect or expired' message", () => {
    const expected = "That code is incorrect or has expired. Request a new one.";
    expect(friendlyAuthError("Token has expired")).toBe(expected);
    expect(friendlyAuthError("Invalid login credentials")).toBe(expected);
    expect(friendlyAuthError("Token not found")).toBe(expected);
  });

  it("maps network errors to a connection message", () => {
    expect(friendlyAuthError("Failed to fetch")).toMatch(/connection/i);
    expect(friendlyAuthError("network error")).toMatch(/connection/i);
  });

  // ENUMERATION-NEUTRALITY GUARD. A 'sign-ups not allowed' style error (which a
  // future shouldCreateUser:false path would surface for UNKNOWN emails only)
  // must NOT produce per-address copy — otherwise it becomes an account-existence
  // oracle. It must collapse to the SAME generic message as any other unmapped
  // error, so existing vs unknown addresses are indistinguishable.
  it("does NOT leak account existence via a 'sign-ups disabled' message", () => {
    const generic = friendlyAuthError("some totally unmapped backend error");
    expect(friendlyAuthError("Signups not allowed for this instance")).toBe(generic);
    expect(friendlyAuthError("Email signups are not allowed")).toBe(generic);
    // It must never echo an address-specific phrase.
    expect(friendlyAuthError("Signups not allowed for this instance")).not.toMatch(/this address|disabled for/i);
  });

  it("never surfaces raw backend text for an unmapped error", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const secretish = "PostgREST error 42501: permission denied for table users";
    const out = friendlyAuthError(secretish);
    expect(out).toBe("Something went wrong. Please try again.");
    expect(out).not.toContain("PostgREST");
    expect(debug).toHaveBeenCalledWith("[auth] unmapped auth error");
    expect(JSON.stringify(debug.mock.calls)).not.toContain(secretish);
  });

  it("never surfaces native browser-open details", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const secretish = new Error(
      "Failed to open https://example.test/?state=private-state",
    );

    expect(safeBrowserSignInStartError(secretish)).toBe(
      "Couldn't start sign-in. Please try again.",
    );
    expect(debug).toHaveBeenCalledWith("[auth] browser sign-in start failed");
    expect(JSON.stringify(debug.mock.calls)).not.toContain("private-state");
  });

  it("explains reviewed recovery without trusting an arbitrary locator", () => {
    expect(
      workOSSignInFailureMessage(
        "account_recovery_required",
        "ZR-ABCD-2345",
      ),
    ).toMatch(/ZR-ABCD-2345/);
    expect(
      workOSSignInFailureMessage(
        "account_recovery_required",
        "<script>alert(1)</script>",
      ),
    ).not.toContain("script");
    expect(workOSSignInFailureMessage("account_exists", null)).toMatch(
      /original sign-in method/i,
    );
  });
});
