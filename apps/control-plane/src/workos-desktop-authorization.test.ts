import { describe, expect, it, vi } from "vitest";

import { createWorkOSDesktopAuthorizationRoutes } from "./workos-desktop-authorization.js";
import { RailwayWorkOSProvider } from "./workos-provider.js";

const APP_ORIGIN = "https://app-alpha.zeros.build";
const STATE = `zeros-alpha.${"s".repeat(43)}`;
const CHALLENGE = "c".repeat(43);

function setup() {
  const desktopAuthorizationUrl = vi.fn(
    (options: {
      state: string;
      codeChallenge: string;
      redirectUri: string;
    }) => {
      const url = new URL("https://api.workos.com/user_management/authorize");
      url.searchParams.set("provider", "authkit");
      url.searchParams.set("client_id", "client_desktop_example");
      url.searchParams.set("redirect_uri", options.redirectUri);
      url.searchParams.set("state", options.state);
      url.searchParams.set("code_challenge", options.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
  );
  return {
    app: createWorkOSDesktopAuthorizationRoutes(
      { desktopAuthorizationUrl },
      APP_ORIGIN,
    ),
    desktopAuthorizationUrl,
  };
}

describe("WorkOS hosted desktop authorization", () => {
  it("selects the independent Desktop Application instead of the web client", () => {
    const provider = new RailwayWorkOSProvider(
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
    const url = new URL(
      provider.desktopAuthorizationUrl({
        state: STATE,
        codeChallenge: CHALLENGE,
        redirectUri: `${APP_ORIGIN}/auth/desktop/callback`,
      }),
    );

    expect(url.searchParams.get("client_id")).toBe("client_desktop_example");
    expect(url.searchParams.get("client_id")).not.toBe("client_web_example");
    expect(url.searchParams.get("provider")).toBe("authkit");
  });

  it("uses Hosted AuthKit with the Desktop Application and fixed app-host callback", async () => {
    const { app, desktopAuthorizationUrl } = setup();
    const response = await app.request(
      `/auth/desktop/start?state=${STATE}&code_challenge=${CHALLENGE}`,
    );

    expect(response.status).toBe(303);
    expect(desktopAuthorizationUrl).toHaveBeenCalledWith({
      state: STATE,
      codeChallenge: CHALLENGE,
      redirectUri: `${APP_ORIGIN}/auth/desktop/callback`,
    });
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("provider")).toBe("authkit");
    expect(location.searchParams.get("client_id")).toBe(
      "client_desktop_example",
    );
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${APP_ORIGIN}/auth/desktop/callback`,
    );
    expect(location.searchParams.has("client_secret")).toBe(false);
  });

  it("makes legacy and hostile provider selectors inert", async () => {
    const { app, desktopAuthorizationUrl } = setup();
    for (const selector of ["google", "github", "authkit", "GitHubOAuth"]) {
      const response = await app.request(
        `/auth/desktop/start?provider=${selector}&state=${STATE}&code_challenge=${CHALLENGE}`,
      );
      expect(response.status).toBe(303);
      expect(
        new URL(response.headers.get("location")!).searchParams.get("provider"),
      ).toBe("authkit");
    }
    expect(desktopAuthorizationUrl).toHaveBeenCalledTimes(4);
    for (const [options] of desktopAuthorizationUrl.mock.calls) {
      expect(options).not.toHaveProperty("provider");
    }
  });

  it("rejects foreign schemes and malformed PKCE before calling WorkOS", async () => {
    const { app, desktopAuthorizationUrl } = setup();
    for (const query of [
      `state=foreign.${"s".repeat(43)}&code_challenge=${CHALLENGE}`,
      `state=${STATE}&code_challenge=short`,
    ]) {
      expect((await app.request(`/auth/desktop/start?${query}`)).status).toBe(
        400,
      );
    }
    expect(desktopAuthorizationUrl).not.toHaveBeenCalled();
  });
});
