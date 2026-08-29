import { describe, expect, it } from "vitest";

import { releaseEnvironmentErrors } from "../release-environment";

describe("desktop release environment routing", () => {
  it("accepts each channel's exact hosted origins", () => {
    for (const [environment, app, api, ref] of [
      [
        "alpha",
        "https://app-alpha.zeros.build",
        "https://api-alpha.zeros.build",
        "refs/heads/main",
      ],
      [
        "beta",
        "https://app-beta.zeros.build",
        "https://api-beta.zeros.build",
        "refs/heads/release/1.2.3",
      ],
      [
        "production",
        "https://app.zeros.build",
        "https://api.zeros.build",
        "refs/heads/release/1.2.3",
      ],
    ] as const) {
      expect(
        releaseEnvironmentErrors(environment, {
          VITE_APP_BASE_URL: app,
          VITE_CONTROL_PLANE_URL: api,
          AUTH_PROVIDER: "auth0",
          GITHUB_REF: ref,
        }),
      ).toEqual([]);
    }
  });

  it("rejects missing, malformed, or cross-environment origins", () => {
    expect(releaseEnvironmentErrors("alpha", {})).toHaveLength(3);
    expect(
      releaseEnvironmentErrors("beta", {
        VITE_APP_BASE_URL: "https://app.zeros.build",
        VITE_CONTROL_PLANE_URL: "https://api.zeros.build/path",
        AUTH_PROVIDER: "auth0",
      }),
    ).toEqual([
      "VITE_APP_BASE_URL must be https://app-beta.zeros.build",
      "VITE_CONTROL_PLANE_URL must be https://api-beta.zeros.build",
    ]);
  });

  it("never permits Beta or Production to release directly from main", () => {
    expect(
      releaseEnvironmentErrors("production", {
        VITE_APP_BASE_URL: "https://app.zeros.build",
        VITE_CONTROL_PLANE_URL: "https://api.zeros.build",
        AUTH_PROVIDER: "auth0",
        GITHUB_REF: "refs/heads/main",
      }),
    ).toEqual(["production releases must run from release/X.Y.Z"]);
    expect(
      releaseEnvironmentErrors("alpha", {
        VITE_APP_BASE_URL: "https://app-alpha.zeros.build",
        VITE_CONTROL_PLANE_URL: "https://api-alpha.zeros.build",
        AUTH_PROVIDER: "auth0",
        GITHUB_REF: "refs/heads/release/1.2.3",
      }),
    ).toEqual(["alpha releases must run from main"]);
  });

  it("requires the exact public WorkOS desktop contract in WorkOS mode", () => {
    const valid = {
      VITE_APP_BASE_URL: "https://app-alpha.zeros.build",
      VITE_CONTROL_PLANE_URL: "https://api-alpha.zeros.build",
      AUTH_PROVIDER: "workos",
      AUTH_DESKTOP_CLIENT_ID: "client_desktop_example",
      AUTH_ISSUER: "https://api.workos.com/user_management/client_web_example",
      AUTH_JWKS_URL: "https://api.workos.com/sso/jwks/client_web_example",
      AUTH_AUDIENCE: "https://api-alpha.zeros.build",
      GITHUB_REF: "refs/heads/main",
    };
    expect(releaseEnvironmentErrors("alpha", valid)).toEqual([]);
    expect(
      releaseEnvironmentErrors("alpha", {
        ...valid,
        AUTH_AUDIENCE: "https://api.zeros.build",
        AUTH_DESKTOP_CLIENT_ID: "",
      }),
    ).toEqual([
      "AUTH_DESKTOP_CLIENT_ID is required in WorkOS mode",
      "AUTH_AUDIENCE must be https://api-alpha.zeros.build in WorkOS mode",
    ]);
  });

  it("rejects every channel-qualified WorkOS API key from a desktop release", () => {
    expect(
      releaseEnvironmentErrors("alpha", {
        VITE_APP_BASE_URL: "https://app-alpha.zeros.build",
        VITE_CONTROL_PLANE_URL: "https://api-alpha.zeros.build",
        AUTH_PROVIDER: "auth0",
        WORKOS_ALPHA_WEB_API_KEY: "server-only",
      }),
    ).toEqual([
      "WORKOS_ALPHA_WEB_API_KEY must never be present in a desktop build",
    ]);
  });
});
