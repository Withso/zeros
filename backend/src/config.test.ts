import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "./config.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://user:pass@localhost:5432/zeros",
    AUTH0_DOMAIN: "tenant.example.com",
    AUTH_AUDIENCE: "https://api.zeros.build",
  };
}

function validEnv(): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    GITHUB_APP_ID: "123456",
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_CLIENT_SECRET: "client-secret-for-tests",
    GITHUB_APP_SLUG: "zeros-test",
    GITHUB_OAUTH_CALLBACK_URL:
      "https://api.example.com/v1/github/oauth/callback",
  };
}

describe("GitHub backend configuration", () => {
  it("reads the confidential App configuration as one block", () => {
    const config = loadConfig(validEnv());
    expect(config.github).toMatchObject({
      appId: 123456,
      clientId: "Iv1.test",
      appSlug: "zeros-test",
      variantKey: "github.com",
      webBaseUrl: "https://github.com",
      apiBaseUrl: "https://api.github.com",
      completionPageUrl: "https://app.zeros.build/github/connected",
    });
  });

  it("allows each control-plane environment to select its completion page", () => {
    expect(
      loadConfig({
        ...validEnv(),
        GITHUB_COMPLETION_PAGE_URL:
          "https://preview.example.com/github/connected",
      }).github?.completionPageUrl,
    ).toBe("https://preview.example.com/github/connected");
  });

  // The regression this guards is a whole-service outage: loadConfig() runs at
  // module scope in index.ts, so a throw here took teams, invitations, settings
  // and /healthz down with GitHub — and on Railway that is a crash loop.
  it("boots without any GitHub App configuration and disables only GitHub", () => {
    const config = loadConfig(baseEnv());

    expect(config.github).toBeNull();
    expect(config.authAudience).toBe("https://api.zeros.build");
    expect(config.databaseUrl).toContain("postgres://");
  });

  it("keeps booting — loudly — when the GitHub block is incomplete", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = validEnv();
    delete env.GITHUB_APP_CLIENT_SECRET;

    const config = loadConfig(env);

    expect(config.github).toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("GITHUB_APP_CLIENT_SECRET"),
    );
    error.mockRestore();
  });

  it("disables GitHub rather than the service for a non-HTTPS callback in production", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const config = loadConfig({
      ...validEnv(),
      NODE_ENV: "production",
      GITHUB_OAUTH_CALLBACK_URL:
        "http://127.0.0.1:8080/v1/github/oauth/callback",
    });

    expect(config.github).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("HTTPS"));
    error.mockRestore();
  });

  it("allows a dev loopback callback outside production", () => {
    expect(
      loadConfig({
        ...validEnv(),
        GITHUB_OAUTH_CALLBACK_URL:
          "http://127.0.0.1:8080/v1/github/oauth/callback",
      }).github?.oauthCallbackUrl,
    ).toBe("http://127.0.0.1:8080/v1/github/oauth/callback");
  });

  it("allows a dev loopback completion page outside production", () => {
    expect(
      loadConfig({
        ...validEnv(),
        GITHUB_COMPLETION_PAGE_URL: "http://127.0.0.1:8788/github/connected",
      }).github?.completionPageUrl,
    ).toBe("http://127.0.0.1:8788/github/connected");
  });

  it("disables GitHub for a non-HTTPS completion page in production", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const config = loadConfig({
      ...validEnv(),
      NODE_ENV: "production",
      GITHUB_COMPLETION_PAGE_URL: "http://127.0.0.1:8788/github/connected",
    });

    expect(config.github).toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("GITHUB_COMPLETION_PAGE_URL"),
    );
    error.mockRestore();
  });

  it("rejects credential-bearing or ambiguous GitHub service URLs", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      loadConfig({
        ...validEnv(),
        GITHUB_WEB_BASE_URL: "https://user:pass@github.example/",
      }).github,
    ).toBeNull();
    expect(
      loadConfig({
        ...validEnv(),
        GITHUB_API_BASE_URL: "https://api.github.example/v3?target=other",
      }).github,
    ).toBeNull();
    expect(
      loadConfig({
        ...validEnv(),
        GITHUB_COMPLETION_PAGE_URL:
          "https://preview.example/github/connected#stale-handoff",
      }).github,
    ).toBeNull();
    error.mockRestore();
    expect(
      loadConfig({
        ...validEnv(),
        GITHUB_API_BASE_URL: "https://github.example/api/v3/",
      }).github?.apiBaseUrl,
    ).toBe("https://github.example/api/v3");
  });

  // Rotating the OAuth client secret is routine. When it doubles as the
  // refresh-binding key, every outstanding binding stops verifying at once and
  // the desktop prompts the whole fleet to reconnect.
  it("lets the refresh-binding key be set independently of the client secret", () => {
    expect(loadConfig(validEnv()).github?.refreshBindingSecret).toBe(
      "client-secret-for-tests",
    );
    expect(
      loadConfig({
        ...validEnv(),
        GITHUB_REFRESH_BINDING_SECRET: "a-separate-binding-key-value",
      }).github?.refreshBindingSecret,
    ).toBe("a-separate-binding-key-value");
  });
});
