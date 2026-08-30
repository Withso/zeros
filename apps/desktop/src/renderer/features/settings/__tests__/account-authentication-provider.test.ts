import { describe, expect, it } from "vitest";

import {
  accountAuthenticationProvider,
  accountAuthenticationProviderLabel,
} from "../account-authentication-provider";

describe("account authentication provider", () => {
  it("identifies Magic Auth sessions as email-code authentication", () => {
    const provider = accountAuthenticationProvider("MagicAuth", null);

    expect(provider).toBe("email-code");
    expect(accountAuthenticationProviderLabel(provider)).toBe("Email code");
  });

  it("retains social-provider and legacy-subject detection", () => {
    expect(accountAuthenticationProvider("GitHubOAuth", null)).toBe("github");
    expect(accountAuthenticationProvider("GoogleOAuth", null)).toBe("google");
    expect(accountAuthenticationProvider(null, "github|123")).toBe("github");
    expect(accountAuthenticationProvider(null, "google-oauth2|123")).toBe(
      "google",
    );
  });

  it("does not mislabel unrelated authentication methods", () => {
    expect(accountAuthenticationProvider("Password", null)).toBeNull();
    expect(accountAuthenticationProvider("Passkey", null)).toBeNull();
    expect(accountAuthenticationProviderLabel(null)).toBeNull();
  });
});
