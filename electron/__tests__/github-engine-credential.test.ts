import { describe, expect, it } from "vitest";

import { githubCredentialForEngine } from "../github-engine-credential";

describe("host-to-engine GitHub credential projection", () => {
  const appCredential = {
    method: "github-app",
    gitHost: "github.com",
    gitHttpUsername: "x-access-token",
    accessToken: "short-lived-access",
    refreshToken: "main-only-refresh",
    ownerSub: "auth0|owner",
    login: "octocat",
    expiresAtMs: 2_000_000,
    refreshTokenExpiresAtMs: 20_000_000,
    installationCount: 1,
  } as const;

  it("serves only the short-lived App working copy to its owner", () => {
    const projected = githubCredentialForEngine(
      appCredential,
      "auth0|owner",
      1_000_000,
    );
    expect(projected).toEqual({
      method: "github-app",
      accessToken: "short-lived-access",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
      login: "octocat",
      expiresAtMs: 2_000_000,
    });
    expect(JSON.stringify(projected)).not.toContain("main-only-refresh");
    expect(JSON.stringify(projected)).not.toContain("auth0|owner");
  });

  it("refuses cross-account, expired, and unbounded App credentials", () => {
    expect(
      githubCredentialForEngine(appCredential, "auth0|another", 1_000_000),
    ).toBeNull();
    expect(
      githubCredentialForEngine(appCredential, "auth0|owner", 2_000_000),
    ).toBeNull();
    const { expiresAtMs: _missing, ...withoutExpiry } = appCredential;
    expect(
      githubCredentialForEngine(withoutExpiry, "auth0|owner", 1_000_000),
    ).toBeNull();
  });

  it("passes a selected PAT through unchanged", () => {
    const pat = {
      method: "pat",
      accessToken: "personal-access",
      login: "octocat",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    } as const;
    expect(githubCredentialForEngine(pat, null, 1_000_000)).toEqual(pat);
  });
});
