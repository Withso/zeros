import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";

import { loadConfig } from "./config.js";
import { cloudAgentCredentialKeys } from "./agent-credentials/agent-credentials.js";
import { openCloudAgentCredential, sealCloudAgentCredential } from "./agent-credentials/agent-credential-envelope.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://user:pass@localhost:5432/zeros",
    AUTH0_DOMAIN: "tenant.example.com",
    AUTH_AUDIENCE: "https://api.zeros.build",
  };
}

describe("offline configuration diagnostics", () => {
  it("lets an in-memory validator suppress every diagnostic without changing boot defaults", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      loadConfig({
        ...baseEnv(),
        GITHUB_APP_ID: "private-diagnostic-sentinel",
        INTERCOM_TOKEN: "synthetic-intercom-token",
        INTERCOM_REGION: "private-diagnostic-sentinel",
        LINEAR_API_KEY: "synthetic-linear-key",
        OPERATIONS_ALERT_EMAIL: "not-an-address",
      }, { error: () => {}, warn: () => {} });
      expect(error.mock.calls.length).toBe(0);
      expect(warn.mock.calls.length).toBe(0);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("chat title credentials", () => {
  it("uses only the dedicated server key, and is optional", () => {
    expect(loadConfig(baseEnv()).chatTitleApiKey).toBeNull();
    expect(loadConfig({ ...baseEnv(), OPENAI_API_KEY: "unrelated-provider-key" }).chatTitleApiKey).toBeNull();
    expect(loadConfig({ ...baseEnv(), CHAT_TITLE_OPENAI_API_KEY: " synthetic-title-key " }).chatTitleApiKey).toBe("synthetic-title-key");
  });
});

describe("database authority configuration", () => {
  it("supports a dedicated direct event listener using runtime privileges", () => {
    const config = loadConfig({...baseEnv(), DATABASE_URL: "postgres://app@primary.test:5432/zeros",
      DATABASE_LISTEN_URL: "postgres://app@primary.test:5432/zeros"});
    expect(config.databaseListenUrl).toBe("postgres://app@primary.test:5432/zeros");
    expect(config.databaseUrl).toBe("postgres://app@primary.test:5432/zeros");
  });
  it("preserves legacy boot while allowing a separate migration connection", () => {
    expect(loadConfig(baseEnv())).toMatchObject({
      databaseMigrationUrl: baseEnv().DATABASE_URL,
      databaseMigrationsOnBoot: true,
      databasePoolMax: 6,
      processRole: "combined",
      shutdownDrainMs: 0,
    });
    expect(loadConfig({ ...baseEnv(), DATABASE_MIGRATION_URL: "postgres://migrator@database.test/zeros", DATABASE_MIGRATIONS_ON_BOOT: "false", DATABASE_POOL_MAX: "6" })).toMatchObject({
      databaseMigrationUrl: "postgres://migrator@database.test:5432/zeros",
      databaseMigrationsOnBoot: false,
      databasePoolMax: 6,
    });
  });

  it.each(["0", "-1", "2.5", "101", "bad"])("rejects unbounded or invalid pool size %s", (max) => {
    expect(() => loadConfig({ ...baseEnv(), DATABASE_POOL_MAX: max })).toThrow();
  });

  it("logs slow requests from one second by default and accepts a bounded override", () => {
    expect(loadConfig(baseEnv()).slowRequestLogMs).toBe(1000);
    expect(loadConfig({ ...baseEnv(), SLOW_REQUEST_LOG_MS: "150" }).slowRequestLogMs).toBe(150);
  });



  it.each(["49", "60001", "2.5", "bad"])("rejects an unbounded slow-request threshold %s", (value) => {
    expect(() => loadConfig({ ...baseEnv(), SLOW_REQUEST_LOG_MS: value })).toThrow();
  });

  it.each(["1"])("reserves both lock and callback capacity (max %s)", max => {
    expect(() => loadConfig({ ...baseEnv(), DATABASE_POOL_MAX: max })).toThrow(/DATABASE_POOL_MAX/);
  });
  it("permits two runtime connections when the listener has its own pool", () => {
    expect(loadConfig({ ...baseEnv(), DATABASE_POOL_MAX: "2", DATABASE_LISTEN_URL: baseEnv().DATABASE_URL }).databasePoolMax).toBe(2);
    expect(loadConfig({ ...baseEnv(), DATABASE_POOL_MAX: "2" }).databasePoolMax).toBe(2);
  });
  it("separates API replica and worker roles without changing placement gates", () => {
    for (const role of ["api", "worker", "realtime", "combined"]) {
      expect(loadConfig({ ...baseEnv(), CONTROL_PLANE_PROCESS_ROLE: role }).processRole).toBe(role);
    }
    expect(() => loadConfig({ ...baseEnv(), CONTROL_PLANE_PROCESS_ROLE: "all" })).toThrow(/CONTROL_PLANE_PROCESS_ROLE/);
  });
  it("keeps the immediate shutdown unless a bounded drain window is configured", () => {
    expect(loadConfig({ ...baseEnv(), CONTROL_PLANE_DRAIN_SECONDS: "30" }).shutdownDrainMs).toBe(30_000);
    for (const value of ["-1", "121", "2.5", "bad"])
      expect(() => loadConfig({ ...baseEnv(), CONTROL_PLANE_DRAIN_SECONDS: value })).toThrow(/CONTROL_PLANE_DRAIN_SECONDS/);
  });
  const psFixture = new URL("postgres://region.horizon.psdb.cloud:5432/zeros?sslmode=verify-full");
  psFixture.username = "app.branchtest";
  psFixture.password = "private-pass";
  const ps = psFixture.href;
  it.each([
    ps.replace(":5432", ":6432"), ps.replace("app.branchtest", "app.branchtest%7Creplica"),
    ps.replace("?sslmode=verify-full", ""), ps.replace("verify-full", "no-verify"),
    ps + "&sslrootcert=system", ps + "&host=other.test", ps + "&sslmode=disable", ps + "&ssl=false",
    "https://database.test/zeros", "not-a-database-url",
  ])("rejects unsafe database connection profile %# without exposing credentials", databaseUrl => {
    let error: unknown;
    try { loadConfig({ ...baseEnv(), DATABASE_URL: databaseUrl }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("DATABASE_URL");
    expect(String(error)).not.toContain("private-pass");
  });
  it.each(["DATABASE_LISTEN_URL", "DATABASE_MIGRATION_URL"])("requires %s to target the same PlanetScale branch and database", key => {
    const env = { ...baseEnv(), DATABASE_URL: ps };
    expect(() => loadConfig({ ...env, [key]: ps.replace("app.branchtest", "migrator.otherbranch") })).toThrow(new RegExp(key));
    expect(() => loadConfig({ ...env, [key]: ps.replace("/zeros?", "/other?") })).toThrow(new RegExp(key));
    expect(loadConfig({ ...env, [key]: ps.replace("app.branchtest", "migrator.branchtest") }).databaseUrl).toBe(ps);
  });
});

describe("trace export configuration", () => {
  it("disables tracing unless an endpoint is configured", () => {
    const config = loadConfig(baseEnv());
    expect(config.tracesUrl).toBeUndefined();
    expect(config.traceSampleRatio).toBe(0);
    for (const value of ["", "   "])
      expect(loadConfig({ ...baseEnv(), OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: value }).tracesUrl).toBeUndefined();
  });

  it("accepts https endpoints and plain http only on private hosts", () => {
    expect(loadConfig({ ...baseEnv(), OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://tempo.example.com/v1/traces" }).tracesUrl)
      .toBe("https://tempo.example.com/v1/traces");
    for (const value of ["http://tempo.railway.internal:4318/v1/traces", "http://localhost:4318/v1/traces"])
      expect(loadConfig({ ...baseEnv(), OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: value }).tracesUrl).toBe(value);
  });

  it.each([
    "http://tempo.example.com/v1/traces",
    "https://user:pass@tempo.example.com/v1/traces",
    "https://tempo.example.com/v1/traces?x=1",
    "not a url",
  ])("rejects trace endpoint %s", value => {
    expect(() => loadConfig({ ...baseEnv(), OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: value }))
      .toThrow(/OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/);
  });

  it("bounds the trace sample ratio to 0 through 1", () => {
    expect(loadConfig({ ...baseEnv(), CONTROL_PLANE_TRACE_SAMPLE_RATIO: "0.25" }).traceSampleRatio).toBe(0.25);
    for (const value of ["1.5", "-0.1"])
      expect(() => loadConfig({ ...baseEnv(), CONTROL_PLANE_TRACE_SAMPLE_RATIO: value })).toThrow();
  });
});

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

function workosEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://user:pass@localhost:5432/zeros",
    AUTH_PROVIDER: "workos",
    APP_ORIGIN: "https://app.zeros.build",
    AUTH_ISSUER: "https://identity.example.com/user_management/client_web",
    AUTH_JWKS_URL: "https://identity.example.com/sso/jwks/client_web",
    AUTH_AUDIENCE: "https://api.zeros.build",
    AUTH_WEB_CLIENT_ID: "client_web",
    AUTH_DESKTOP_CLIENT_ID: "client_desktop",
    WORKOS_API_KEY: "workos-api-key-for-tests",
    WORKOS_COOKIE_PASSWORD: "cookie-password-for-tests".repeat(2),
    WORKOS_WEBHOOK_SECRET: "webhook-secret-for-tests",
  };
}

describe("provider-neutral authentication configuration", () => {
  it("loads the explicit WorkOS resource-server contract without AUTH0_DOMAIN", () => {
    const config = loadConfig(workosEnv());
    expect(config.auth).toEqual({
      provider: "workos",
      issuer: "https://identity.example.com/user_management/client_web",
      jwksUrl: "https://identity.example.com/sso/jwks/client_web",
      audience: "https://api.zeros.build",
      webClientId: "client_web",
      desktopClientId: "client_desktop",
    });
    expect(config.workos).toEqual({
      appOrigin: "https://app.zeros.build",
      opsOrigin: null,
      apiKey: "workos-api-key-for-tests",
      cookiePassword: "cookie-password-for-testscookie-password-for-tests",
      webhookSecret: "webhook-secret-for-tests",
    });
    expect(config.inviteLinkBase).toBe("https://app.zeros.build/invite");
  });

  it("validates a separate Ops origin without making it an identity authority", () => {
    const config = loadConfig({
      ...workosEnv(),
      OPS_ORIGIN: "https://ops.zeros.build",
    });
    expect(config.workos?.opsOrigin).toBe("https://ops.zeros.build");
    expect(() =>
      loadConfig({
        ...workosEnv(),
        OPS_ORIGIN: "https://app.zeros.build",
      }),
    ).toThrow(/separate origins/);
  });

  it("refuses to send WorkOS invitations through another app origin", () => {
    expect(() =>
      loadConfig({
        ...workosEnv(),
        INVITE_LINK_BASE: "https://app-alpha.zeros.build/invite",
      }),
    ).toThrow(/INVITE_LINK_BASE.*APP_ORIGIN/);
  });

  it.each([
    "http://app.zeros.build/invite",
    "https://user:secret@app.zeros.build/invite",
    "https://app.zeros.build/invite/redirect",
    "https://app.zeros.build/invite?next=elsewhere",
    "https://app.zeros.build/invite#fragment",
  ])("rejects a non-canonical invitation endpoint: %s", (inviteLinkBase) => {
    expect(() =>
      loadConfig({
        ...workosEnv(),
        INVITE_LINK_BASE: inviteLinkBase,
      }),
    ).toThrow(/INVITE_LINK_BASE/);
  });

  it("fails closed when WorkOS client IDs are missing or shared", () => {
    const missingDesktop = workosEnv();
    delete missingDesktop.AUTH_DESKTOP_CLIENT_ID;
    expect(() => loadConfig(missingDesktop)).toThrow(/AUTH_DESKTOP_CLIENT_ID/);

    expect(() =>
      loadConfig({
        ...workosEnv(),
        AUTH_DESKTOP_CLIENT_ID: "client_web",
      }),
    ).toThrow(/must be different/);
  });

  it("requires Railway-owned browser credentials only in WorkOS mode", () => {
    for (const name of [
      "APP_ORIGIN",
      "WORKOS_API_KEY",
      "WORKOS_COOKIE_PASSWORD",
      "WORKOS_WEBHOOK_SECRET",
    ] as const) {
      const missing = workosEnv();
      delete missing[name];
      expect(() => loadConfig(missing)).toThrow(new RegExp(name));
    }

    expect(loadConfig(baseEnv()).workos).toBeNull();
  });

  it("checks WorkOS secret lengths after trimming environment whitespace", () => {
    expect(() =>
      loadConfig({
        ...workosEnv(),
        WORKOS_COOKIE_PASSWORD: ` ${"x".repeat(30)} `,
      }),
    ).toThrow(/WORKOS_COOKIE_PASSWORD/);
    expect(() =>
      loadConfig({
        ...workosEnv(),
        WORKOS_WEBHOOK_SECRET: ` ${"x".repeat(14)} `,
      }),
    ).toThrow(/WORKOS_WEBHOOK_SECRET/);
  });

  it("rejects an unsafe or path-bearing WorkOS app origin", () => {
    expect(() =>
      loadConfig({ ...workosEnv(), APP_ORIGIN: "http://app.zeros.build" }),
    ).toThrow(/APP_ORIGIN/);
    expect(() =>
      loadConfig({
        ...workosEnv(),
        APP_ORIGIN: "https://app.zeros.build/path",
      }),
    ).toThrow(/APP_ORIGIN/);
  });

  it("keeps the legacy Auth0 deployment bootable during the staged cutover", () => {
    expect(loadConfig(baseEnv()).auth).toEqual({
      provider: "auth0",
      issuers: ["https://tenant.example.com/"],
      jwksUrl: "https://tenant.example.com/.well-known/jwks.json",
      audience: "https://api.zeros.build",
    });
  });

  it("uses an explicitly configured Auth0 app origin for invitation links", () => {
    expect(
      loadConfig({
        ...baseEnv(),
        AUTH_PROVIDER: "auth0",
        APP_ORIGIN: "https://app-alpha.zeros.build",
      }).inviteLinkBase,
    ).toBe("https://app-alpha.zeros.build/invite");
  });

  it("accepts explicit provider-neutral Auth0 verification URLs", () => {
    expect(
      loadConfig({
        DATABASE_URL: "postgres://user:pass@localhost:5432/zeros",
        AUTH_PROVIDER: "auth0",
        AUTH_ISSUER: "https://legacy-issuer.example/",
        AUTH_JWKS_URL: "https://legacy-issuer.example/jwks.json",
        AUTH_AUDIENCE: "https://api.zeros.build",
      }).auth,
    ).toEqual({
      provider: "auth0",
      issuers: ["https://legacy-issuer.example/"],
      jwksUrl: "https://legacy-issuer.example/jwks.json",
      audience: "https://api.zeros.build",
    });
  });
});

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

  it("accepts an optional backend-only RSA key for cloud installation tokens", () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(
      loadConfig({
        ...validEnv(),
        GITHUB_APP_PRIVATE_KEY: privateKey.replaceAll("\n", "\\n"),
      }).github?.privateKey,
    ).toBe(privateKey.trim());
  });

  // The regression this guards is a whole-service outage: loadConfig() runs at
  // module scope in index.ts, so a throw here took teams, invitations, settings
  // and /healthz down with GitHub — and on Railway that is a crash loop.
  it("boots without any GitHub App configuration and disables only GitHub", () => {
    const config = loadConfig(baseEnv());

    expect(config.github).toBeNull();
    expect(config.auth.audience).toBe("https://api.zeros.build");
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
          INVITE_LINK_BASE:
            name === "alpha"
              ? "https://app-alpha.zeros.build/invite"
              : name === "beta"
                ? "https://app-beta.zeros.build/invite"
                : "https://app.zeros.build/invite",
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

  it("rejects a WorkOS browser origin from another Railway channel", () => {
    expect(() =>
      loadConfig({
        ...workosEnv(),
        AUTH_AUDIENCE: "https://api-alpha.zeros.build",
        APP_ORIGIN: "https://app.zeros.build",
        RAILWAY_PROJECT_ID: "project-1",
        RAILWAY_ENVIRONMENT_NAME: "alpha",
        RAILWAY_GIT_BRANCH: "main",
      }),
    ).toThrow(/APP_ORIGIN must be https:\/\/app-alpha\.zeros\.build/);
  });

  it("requires the isolated Ops origin in WorkOS Alpha and Production", () => {
    const alpha = {
      ...workosEnv(),
      AUTH_AUDIENCE: "https://api-alpha.zeros.build",
      APP_ORIGIN: "https://app-alpha.zeros.build",
      INVITE_LINK_BASE: "https://app-alpha.zeros.build/invite",
      RAILWAY_PROJECT_ID: "project-1",
      RAILWAY_ENVIRONMENT_NAME: "alpha",
      RAILWAY_GIT_BRANCH: "main",
    };
    expect(() => loadConfig(alpha)).toThrow(
      /OPS_ORIGIN must be https:\/\/ops-alpha\.zeros\.build/,
    );
    expect(() =>
      loadConfig({ ...alpha, OPS_ORIGIN: "https://ops-alpha.zeros.build" }),
    ).not.toThrow();
  });

  it("rejects a cross-channel invitation page during an Auth0 rollback", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        AUTH_AUDIENCE: "https://api-alpha.zeros.build",
        INVITE_LINK_BASE: "https://app.zeros.build/invite",
        RAILWAY_PROJECT_ID: "project-1",
        RAILWAY_ENVIRONMENT_NAME: "alpha",
        RAILWAY_GIT_BRANCH: "main",
      }),
    ).toThrow(
      /INVITE_LINK_BASE must be https:\/\/app-alpha\.zeros\.build\/invite/,
    );
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

  it("allows an explicit self-hosted Railway template to use provided domains", () => {
    expect(() =>
      loadConfig({
        ...workosEnv(),
        AUTH_AUDIENCE: "https://zeros-api-template.up.railway.app",
        APP_ORIGIN: "https://zeros-app-template.up.railway.app",
        RAILWAY_PROJECT_ID: "customer-project",
        RAILWAY_ENVIRONMENT_NAME: "production",
        RAILWAY_GIT_BRANCH: "main",
        ZEROS_SELF_HOSTED: "true",
      }),
    ).not.toThrow();
    expect(() =>
      loadConfig({ ...workosEnv(), ZEROS_SELF_HOSTED: "yes" }),
    ).toThrow(/ZEROS_SELF_HOSTED/);
  });

  it("keeps the WorkOS browser and public API on separate origins", () => {
    expect(() =>
      loadConfig({
        ...workosEnv(),
        AUTH_AUDIENCE: "https://zeros-template.up.railway.app",
        APP_ORIGIN: "https://zeros-template.up.railway.app",
        ZEROS_SELF_HOSTED: "true",
      }),
    ).toThrow(/separate origins/);
  });
});
