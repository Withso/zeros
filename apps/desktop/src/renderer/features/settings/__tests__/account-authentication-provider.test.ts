import { describe, expect, it } from "vitest";

import {
  accountAuthenticationProvider,
  accountAuthenticationProviderLabel,
} from "../account-authentication-provider";

describe("account authentication provider", () => {
  it("identifies Magic Auth sessions as email-code authentication", () => {
    const provider = accountAuthenticationProvider("MagicAuth");

    expect(provider).toBe("email-code");
    expect(accountAuthenticationProviderLabel(provider)).toBe("Email code");
  });

  it("identifies social sign-in methods", () => {
    expect(accountAuthenticationProvider("GitHubOAuth")).toBe("github");
    expect(accountAuthenticationProvider("GoogleOAuth")).toBe("google");
  });

  it("does not mislabel unrelated authentication methods", () => {
    expect(accountAuthenticationProvider("Password")).toBeNull();
    expect(accountAuthenticationProvider("Passkey")).toBeNull();
    expect(accountAuthenticationProvider(null)).toBeNull();
    expect(accountAuthenticationProviderLabel(null)).toBeNull();
  });
});
