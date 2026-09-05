import { describe, expect, it } from "vitest";

import { devWorkOSConfigurationIssue } from "../dev-workos-auth-policy";
import type { DesktopAuthConfig } from "../workos-desktop-config";

const workos: DesktopAuthConfig = {
  provider: "workos",
  desktopClientId: "client_desktop_example",
  issuer: "https://api.workos.com/user_management/client_web_example",
  jwksUrl: "https://api.workos.com/sso/jwks/client_web_example",
  audience: "https://api-alpha.zeros.build",
};

describe("Zeros Dev WorkOS policy", () => {
  it("accepts only the complete Alpha public-client boundary", () => {
    expect(
      devWorkOSConfigurationIssue({
        auth: workos,
        appOrigin: "https://app-alpha.zeros.build",
        controlPlaneOrigin: "https://api-alpha.zeros.build",
      }),
    ).toBeNull();
  });

  it("rejects the legacy provider instead of silently opening its retired flow", () => {
    expect(
      devWorkOSConfigurationIssue({
        auth: { provider: "auth0" },
        appOrigin: "https://app-alpha.zeros.build",
        controlPlaneOrigin: "https://api-alpha.zeros.build",
      }),
    ).toBe("provider");
  });

  it.each([
    ["production app", { appOrigin: "https://app.zeros.build" }, "app_origin"],
    [
      "production API",
      { controlPlaneOrigin: "https://api.zeros.build" },
      "control_plane_origin",
    ],
    [
      "production audience",
      { auth: { ...workos, audience: "https://api.zeros.build" } },
      "audience",
    ],
    [
      "mismatched WorkOS applications",
      {
        auth: {
          ...workos,
          jwksUrl: "https://api.workos.com/sso/jwks/client_other_web",
        },
      },
      "token_contract",
    ],
    [
      "a malformed Desktop Application id",
      { auth: { ...workos, desktopClientId: "desktop_example" } },
      "token_contract",
    ],
  ])("rejects %s", (_label, overrides, issue) => {
    expect(
      devWorkOSConfigurationIssue({
        auth: workos,
        appOrigin: "https://app-alpha.zeros.build",
        controlPlaneOrigin: "https://api-alpha.zeros.build",
        ...overrides,
      }),
    ).toBe(issue);
  });
});
