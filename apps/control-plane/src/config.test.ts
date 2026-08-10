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

describe("feedback backend configuration", () => {
  it("keeps feedback optional when no destination is configured", () => {
    expect(loadConfig(baseEnv()).feedback).toBeNull();
  });

  it("loads Intercom and Linear credentials only on the backend", () => {
    const feedback = loadConfig({
      ...baseEnv(),
      INTERCOM_TOKEN: "test-intercom-token",
      INTERCOM_REGION: "eu",
      INTERCOM_ADMIN_ID: "admin-1",
      INTERCOM_TAG_IDS: '{"bug":"tag-1"}',
      INTERCOM_APP_ID: "workspace-1",
      LINEAR_API_KEY: "test-linear-key",
      LINEAR_TEAM_ID: "team-1",
      LINEAR_LABEL_IDS: '{"feature":"label-1"}',
      POSTHOG_PROJECT_URL: "https://eu.posthog.com/project/123/",
    }).feedback;

    expect(feedback).toEqual({
      intercom: {
        token: "test-intercom-token",
        region: "eu",
        adminId: "admin-1",
        tagIds: { bug: "tag-1" },
        appId: "workspace-1",
      },
      linear: {
        apiKey: "test-linear-key",
        teamId: "team-1",
        labelIds: { feature: "label-1" },
      },
      posthogProjectUrl: "https://eu.posthog.com/project/123",
    });
  });

  it("normalizes legacy issue maps into the canonical bug mapping", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const feedback = loadConfig({
      ...baseEnv(),
      INTERCOM_TOKEN: "test-intercom-token",
      INTERCOM_ADMIN_ID: "admin-1",
      INTERCOM_TAG_IDS: '{"issue":"legacy-issue-tag"}',
      LINEAR_API_KEY: "test-linear-key",
      LINEAR_TEAM_ID: "team-1",
      LINEAR_LABEL_IDS:
        '{"issue":"legacy-issue-label","bug":"canonical-bug-label"}',
    }).feedback;

    expect(feedback?.intercom?.tagIds).toEqual({
      bug: "legacy-issue-tag",
    });
    expect(feedback?.linear?.labelIds).toEqual({
      bug: "canonical-bug-label",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('legacy "issue"'),
    );
    warn.mockRestore();
  });

  it("disables only an incomplete destination and keeps the service bootable", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const feedback = loadConfig({
      ...baseEnv(),
      INTERCOM_REGION: "au",
      LINEAR_API_KEY: "test-linear-key",
      LINEAR_TEAM_ID: "team-1",
    }).feedback;

    expect(feedback?.intercom).toBeNull();
    expect(feedback?.linear?.teamId).toBe("team-1");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("INTERCOM_TOKEN is missing"),
    );
    error.mockRestore();
  });

  it("does not send to the wrong Intercom region when the region is invalid", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const feedback = loadConfig({
      ...baseEnv(),
      INTERCOM_TOKEN: "test-intercom-token",
      INTERCOM_REGION: "mars",
    }).feedback;

    expect(feedback).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("DISABLED"));
    error.mockRestore();
  });

  it("ignores malformed optional maps without disabling delivery", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const feedback = loadConfig({
      ...baseEnv(),
      INTERCOM_TOKEN: "test-intercom-token",
      INTERCOM_TAG_IDS: "not-json",
      LINEAR_API_KEY: "test-linear-key",
      LINEAR_TEAM_ID: "team-1",
      LINEAR_LABEL_IDS: '{"unknown":"label"}',
      POSTHOG_PROJECT_URL: "http://not-secure.example/project/1",
    }).feedback;

    expect(feedback?.intercom?.tagIds).toEqual({});
    expect(feedback?.linear?.labelIds).toEqual({});
    expect(feedback?.posthogProjectUrl).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("Railway deployment environment isolation", () => {
  it("accepts the matching Alpha and release-branch Beta/Production wiring", () => {
    for (const [name, audience, branch] of [
      ["alpha", "https://api-alpha.zeros.build", "main"],
      ["beta", "https://api-beta.zeros.build", "release/1.2.3"],
      ["production", "https://api.zeros.build", "release/1.2.3"],
    ] as const) {
      expect(() =>
        loadConfig({
          ...baseEnv(),
          AUTH_AUDIENCE: audience,
          RAILWAY_PROJECT_ID: "project-1",
          RAILWAY_ENVIRONMENT_NAME: name,
          RAILWAY_GIT_BRANCH: branch,
        }),
      ).not.toThrow();
    }
  });

  it("rejects an unknown Railway environment or cross-environment audience", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        RAILWAY_PROJECT_ID: "project-1",
        RAILWAY_ENVIRONMENT_NAME: "staging",
      }),
    ).toThrow(/alpha, beta, or production/);
    expect(() =>
      loadConfig({
        ...baseEnv(),
        RAILWAY_PROJECT_ID: "project-1",
        RAILWAY_ENVIRONMENT_NAME: "alpha",
        RAILWAY_GIT_BRANCH: "main",
      }),
    ).toThrow(/api-alpha/);
  });

  it("refuses a Git-connected production deployment directly from main", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        RAILWAY_PROJECT_ID: "project-1",
        RAILWAY_ENVIRONMENT_NAME: "production",
        RAILWAY_GIT_BRANCH: "main",
      }),
    ).toThrow(/expected release\/X\.Y\.Z/);
  });

  it("refuses hosted deployments whose source branch cannot be proven", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        RAILWAY_PROJECT_ID: "project-1",
        RAILWAY_ENVIRONMENT_NAME: "production",
      }),
    ).toThrow(/requires a Git-connected deployment/);
  });
});
