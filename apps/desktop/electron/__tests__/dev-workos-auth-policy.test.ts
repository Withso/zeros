import { describe, expect, it } from "vitest";

import { devWorkOSConfigurationIssue, workspaceDevAuthProfile } from "../dev-workos-auth-policy";
import type { DesktopAuthConfig } from "../workos-desktop-config";

const workos: DesktopAuthConfig = {
  provider: "workos",
  desktopClientId: "client_desktop_example",
  issuer: "https://api.workos.com/user_management/client_web_example",
  jwksUrl: "https://api.workos.com/sso/jwks/client_web_example",
  audience: "https://api-alpha.zeros.build",
};

describe("Zeros Dev WorkOS policy", () => {
  const owner = "a".repeat(24);
  const profile = {
    version: 1, owner, domain: "example.test", webClientId: "client_dev_web", desktopClientId: "client_dev_desktop",
    audience: "https://api-dev.example.test", appOrigin: `https://app-dev-${owner}.example.test`,
    apiOrigin: `https://api-dev-${owner}.example.test`, issuer: "https://api.workos.com/user_management/client_dev_web",
    jwksUrl: "https://api.workos.com/sso/jwks/client_dev_web",
  };
  const local = {
    auth: { provider: "workos", desktopClientId: profile.desktopClientId, issuer: profile.issuer,
      jwksUrl: profile.jwksUrl, audience: profile.audience } as DesktopAuthConfig,
    appOrigin: profile.appOrigin, controlPlaneOrigin: profile.apiOrigin,
    localProfile: JSON.stringify(profile), isolated: true,
  };
  it("accepts the isolated workspace Dev contract without changing the Alpha default", () => {
    expect(devWorkOSConfigurationIssue(local)).toBeNull();
    expect(devWorkOSConfigurationIssue({ ...local, localProfile: undefined })).toBe("app_origin");
    expect(devWorkOSConfigurationIssue({ ...local, isolated: false })).toBe("local_profile");
  });
  it.each(["local", "hosted"])("keeps the %s profile explicit for sign-in and callback routing", mode => {
    const env = { ZEROS_DEV_ENVIRONMENT: mode, ZEROS_DEV_AUTH_PROFILE: local.localProfile };
    expect(devWorkOSConfigurationIssue({ ...local, localProfile: workspaceDevAuthProfile(env) })).toBeNull();
    expect(devWorkOSConfigurationIssue({ ...local, localProfile: workspaceDevAuthProfile({ ZEROS_DEV_ENVIRONMENT: mode }) })).toBe("local_profile");
    expect(workspaceDevAuthProfile({})).toBeUndefined();
  });
  it("allows explicitly shared Alpha identity while keeping both backend origins local to the checkout", () => {
    const alpha = { ...profile, authEnvironment: "alpha", audience: "https://api-alpha.zeros.build" };
    expect(devWorkOSConfigurationIssue({ ...local, auth: { ...local.auth, audience: alpha.audience } as DesktopAuthConfig,
      localProfile: JSON.stringify(alpha) })).toBeNull();
    expect(devWorkOSConfigurationIssue({ ...local, localProfile: JSON.stringify(alpha) })).toBe("audience");
    expect(devWorkOSConfigurationIssue({ ...local, localProfile: JSON.stringify({ ...alpha, apiOrigin: alpha.audience }) })).toBe("local_profile");
  });
  it("rejects cross-workspace, release-origin and token-contract substitutions", () => {
    expect(devWorkOSConfigurationIssue({ ...local, controlPlaneOrigin: profile.apiOrigin.replace(owner, "b".repeat(24)) })).toBe("control_plane_origin");
    expect(devWorkOSConfigurationIssue({ ...local, appOrigin: "https://app.zeros.build" })).toBe("app_origin");
    expect(devWorkOSConfigurationIssue({ ...local, localProfile: JSON.stringify({ ...profile, apiOrigin: "https://api.zeros.build" }) })).toBe("local_profile");
    expect(devWorkOSConfigurationIssue({ ...local, localProfile: "{invalid" })).toBe("local_profile");
    expect(devWorkOSConfigurationIssue({ ...local, auth: { ...workos, audience: profile.audience } })).toBe("token_contract");
  });
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
