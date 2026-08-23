import { describe, expect, it } from "vitest";

import { resolveDesktopAuthConfig } from "../workos-desktop-config";

const workosConfig = {
  provider: "workos",
  desktopClientId: "client_desktop_example",
  issuer: "https://api.workos.com/user_management/client_web_example",
  jwksUrl: "https://api.workos.com/sso/jwks/client_web_example",
  audience: "https://api-alpha.zeros.build",
} as const;

describe("desktop authentication configuration", () => {
  it("keeps Auth0 compatibility selectable without WorkOS values", () => {
    expect(resolveDesktopAuthConfig({ provider: "auth0" })).toEqual({
      provider: "auth0",
    });
  });

  it("requires and returns the exact public WorkOS contract", () => {
    expect(resolveDesktopAuthConfig(workosConfig)).toEqual(workosConfig);
  });

  it("preserves exact configured URL spelling, including trailing slashes", () => {
    const config = {
      ...workosConfig,
      issuer: `${workosConfig.issuer}/`,
      jwksUrl: `${workosConfig.jwksUrl}/`,
    };
    expect(resolveDesktopAuthConfig(config)).toEqual(config);
  });

  it("fails closed when any WorkOS public-client value is absent", () => {
    for (const key of [
      "desktopClientId",
      "issuer",
      "jwksUrl",
      "audience",
    ] as const) {
      expect(() =>
        resolveDesktopAuthConfig({ ...workosConfig, [key]: "" }),
      ).toThrow(/must be configured/i);
    }
  });

  it("rejects insecure or non-exact verification URLs", () => {
    expect(() =>
      resolveDesktopAuthConfig({
        ...workosConfig,
        issuer: "http://api.workos.com/user_management/client_web_example",
      }),
    ).toThrow(/HTTPS/i);
    expect(() =>
      resolveDesktopAuthConfig({
        ...workosConfig,
        jwksUrl:
          "https://api.workos.com/sso/jwks/client_web_example?channel=alpha",
      }),
    ).toThrow(/query|fragment/i);
  });

  it("rejects an unknown provider instead of silently falling back", () => {
    expect(() => resolveDesktopAuthConfig({ provider: "other" })).toThrow(
      /auth0 or workos/i,
    );
  });
});
