import { describe, expect, it } from "vitest";

import {
  GITHUB_AUTH_METHODS,
  githubCredentialToken,
  isGithubAuthMethod,
  sanitizeGithubCredential,
} from "../github-auth";

describe("GitHub auth model", () => {
  it("keeps the three user-visible methods in their designed order", () => {
    expect(GITHUB_AUTH_METHODS).toEqual(["gh-cli", "github-app", "pat"]);
  });

  it("rejects unknown persisted methods", () => {
    expect(isGithubAuthMethod("gh-cli")).toBe(true);
    expect(isGithubAuthMethod("oauth")).toBe(false);
    expect(isGithubAuthMethod(null)).toBe(false);
  });

  it("normalizes credentials without changing their method", () => {
    const credential = sanitizeGithubCredential({
      method: "pat",
      accessToken: "  github_pat_example  ",
      login: " octocat ",
    });

    expect(credential).toEqual({
      method: "pat",
      accessToken: "github_pat_example",
      login: "octocat",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    });
    expect(githubCredentialToken(credential)).toBe("github_pat_example");
  });

  it("persists an explicit git host and HTTP username on every credential", () => {
    expect(
      sanitizeGithubCredential({
        method: "pat",
        accessToken: "gitlab-token",
        gitHost: "gitlab.com",
        gitHttpUsername: "oauth2",
      }),
    ).toEqual({
      method: "pat",
      accessToken: "gitlab-token",
      gitHost: "gitlab.com",
      gitHttpUsername: "oauth2",
    });
  });

  it("rejects malformed and cross-method credential records", () => {
    expect(
      sanitizeGithubCredential({
        method: "pat",
        accessToken: "",
      }),
    ).toBeNull();
    expect(
      sanitizeGithubCredential({
        method: "pat",
        accessToken: `prefix\n${"x".repeat(32)}`,
      }),
    ).toBeNull();
    expect(
      sanitizeGithubCredential({
        method: "pat",
        accessToken: "secret",
        login: "octocat\nforged",
      }),
    ).toBeNull();
    expect(
      sanitizeGithubCredential({
        method: "oauth",
        accessToken: "secret",
      }),
    ).toBeNull();
    expect(
      sanitizeGithubCredential({
        method: "pat",
        accessToken: "secret",
        gitHost: "github.com",
        gitHttpUsername: "unsafe\nusername",
      }),
    ).toBeNull();
    expect(
      sanitizeGithubCredential({
        method: "github-app",
        accessToken: "secret",
        refreshBinding: "not-a-signed-binding",
      }),
    ).toBeNull();
  });

  it("keeps a namespaced refresh binding only on an App credential", () => {
    const refreshBinding = `zghrb_v1.${"a".repeat(43)}.${"b".repeat(43)}`;
    expect(
      sanitizeGithubCredential({
        method: "github-app",
        accessToken: "secret",
        refreshToken: "refresh",
        refreshBinding,
      }),
    ).toMatchObject({ refreshBinding });
  });
});
