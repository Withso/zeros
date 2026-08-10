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
          GITHUB_REF: ref,
        }),
      ).toEqual([]);
    }
  });

  it("rejects missing, malformed, or cross-environment origins", () => {
    expect(releaseEnvironmentErrors("alpha", {})).toHaveLength(2);
    expect(
      releaseEnvironmentErrors("beta", {
        VITE_APP_BASE_URL: "https://app.zeros.build",
        VITE_CONTROL_PLANE_URL: "https://api.zeros.build/path",
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
        GITHUB_REF: "refs/heads/main",
      }),
    ).toEqual(["production releases must run from release/X.Y.Z"]);
    expect(
      releaseEnvironmentErrors("alpha", {
        VITE_APP_BASE_URL: "https://app-alpha.zeros.build",
        VITE_CONTROL_PLANE_URL: "https://api-alpha.zeros.build",
        GITHUB_REF: "refs/heads/release/1.2.3",
      }),
    ).toEqual(["alpha releases must run from main"]);
  });
});
