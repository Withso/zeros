import { describe, expect, it } from "vitest";

import { RailwayWorkOSProvider } from "./workos-provider.js";

const APP_ORIGIN = "https://app-alpha.zeros.build";
const STATE = "s".repeat(43);
const CHALLENGE = "c".repeat(43);

function provider(): RailwayWorkOSProvider {
  return new RailwayWorkOSProvider(
    {
      provider: "workos",
      issuer: "https://api.workos.com/user_management/client_web_example",
      jwksUrl: "https://api.workos.com/sso/jwks/client_web_example",
      audience: "https://api-alpha.zeros.build",
      webClientId: "client_web_example",
      desktopClientId: "client_desktop_example",
    },
    {
      appOrigin: APP_ORIGIN,
      apiKey: "workos-key-for-tests",
      cookiePassword: "cookie-password-for-tests".repeat(2),
      webhookSecret: "webhook-secret-for-tests",
    },
  );
}

describe("WorkOS Hosted AuthKit authorization", () => {
  it("always starts the hosted UI for the web application with PKCE", () => {
    const url = new URL(
      provider().authorizationUrl({
        state: STATE,
        codeChallenge: CHALLENGE,
        redirectUri: `${APP_ORIGIN}/auth/callback`,
      }),
    );

    expect(url.origin).toBe("https://api.workos.com");
    expect(url.pathname).toBe("/user_management/authorize");
    expect(url.searchParams.get("provider")).toBe("authkit");
    expect(url.searchParams.get("client_id")).toBe("client_web_example");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${APP_ORIGIN}/auth/callback`,
    );
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("always starts the hosted UI for the independent desktop application", () => {
    const url = new URL(
      provider().desktopAuthorizationUrl({
        state: `zeros-alpha.${STATE}`,
        codeChallenge: CHALLENGE,
        redirectUri: `${APP_ORIGIN}/auth/desktop/callback`,
      }),
    );

    expect(url.searchParams.get("provider")).toBe("authkit");
    expect(url.searchParams.get("client_id")).toBe("client_desktop_example");
    expect(url.searchParams.get("client_id")).not.toBe("client_web_example");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${APP_ORIGIN}/auth/desktop/callback`,
    );
    expect(url.searchParams.has("client_secret")).toBe(false);
  });
});
