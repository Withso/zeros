import { describe, expect, it } from "vitest";

import {
  resolveDesktopEngineAuthEnv,
  stripWorkOSApiKeys,
} from "../desktop-engine-auth-config";

describe("desktop engine account-token configuration", () => {
  it("pins the engine to the exact WorkOS desktop access-token contract", () => {
    expect(
      resolveDesktopEngineAuthEnv(
        {
          provider: "workos",
          desktopClientId: "client_desktop_example",
          issuer: "https://api.workos.com/user_management/client_web_example",
          jwksUrl: "https://api.workos.com/sso/jwks/client_web_example",
          audience: "https://api-alpha.zeros.build",
        },
        {},
        false,
      ),
    ).toEqual({
      ZEROS_ACCOUNT_JWT_SECRET: "",
      ZEROS_ACCOUNT_JWT_PUBLIC_KEY: "",
      ZEROS_ACCOUNT_JWT_ISSUER: "",
      ZEROS_ACCOUNT_JWT_JWKS_URL:
        "https://api.workos.com/sso/jwks/client_web_example",
      ZEROS_ACCOUNT_JWT_ISS:
        "https://api.workos.com/user_management/client_web_example",
      ZEROS_ACCOUNT_JWT_AUD: "https://api-alpha.zeros.build",
      ZEROS_ACCOUNT_JWT_CONTRACT: "zeros-access-v1",
      ZEROS_ACCOUNT_JWT_CLIENT_ID: "client_desktop_example",
      ZEROS_REQUIRE_ACCOUNT: "1",
    });
  });

  it("keeps legacy Auth0 derivation selectable during migration", () => {
    expect(
      resolveDesktopEngineAuthEnv(
        { provider: "auth0" },
        {
          AUTH0_DOMAIN: "tenant.example.com",
          AUTH_AUDIENCE: "https://api.example.com",
        },
        false,
      ),
    ).toEqual({
      ZEROS_ACCOUNT_JWT_JWKS_URL:
        "https://tenant.example.com/.well-known/jwks.json",
      ZEROS_ACCOUNT_JWT_ISS: "https://tenant.example.com/",
      ZEROS_ACCOUNT_JWT_AUD: "https://api.example.com",
      ZEROS_ACCOUNT_JWT_CONTRACT: "",
      ZEROS_ACCOUNT_JWT_CLIENT_ID: "",
      ZEROS_REQUIRE_ACCOUNT: "1",
    });
  });

  it("never forwards a WorkOS API key to the engine", () => {
    const output = resolveDesktopEngineAuthEnv(
      {
        provider: "workos",
        desktopClientId: "client_desktop_example",
        issuer: "https://issuer.example/exact/",
        jwksUrl: "https://issuer.example/jwks/",
        audience: "https://api-alpha.zeros.build",
      },
      {
        WORKOS_API_KEY: "must-not-cross-this-boundary",
        WORKOS_DESKTOP_API_KEY: "must-not-cross-this-boundary",
      },
      true,
    );
    const childEnv = stripWorkOSApiKeys({
      WORKOS_API_KEY: "must-not-cross-this-boundary",
      WORKOS_ALPHA_WEB_API_KEY: "must-not-cross-this-boundary",
      ...output,
    });
    expect(JSON.stringify(childEnv)).not.toContain(
      "must-not-cross-this-boundary",
    );
    expect(childEnv.WORKOS_API_KEY).toBeUndefined();
    expect(childEnv.WORKOS_ALPHA_WEB_API_KEY).toBeUndefined();
    expect(output.ZEROS_REQUIRE_ACCOUNT).toBe("0");
  });
});
