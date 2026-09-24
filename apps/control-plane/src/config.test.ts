import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";

import { loadConfig } from "./config.js";
import {
  cloudWorkspaceProvisioningProfile,
  configuredCloudWorkspaceProviders,
} from "./cloud-workspaces/provisioning-profile.js";
import {
  CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
  MIN_CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
} from "./cloud-workspaces/engine-protocol-version.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://user:pass@localhost:5432/zeros",
    AUTH0_DOMAIN: "tenant.example.com",
    AUTH_AUDIENCE: "https://api.zeros.build",
  };
}

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
      databasePoolMax: 10,
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

  it("sends health alerts only to one operator mailbox and never fails boot over it", () => {
    expect(loadConfig(baseEnv()).operationsAlertEmail).toBeNull();
    expect(loadConfig({ ...baseEnv(), OPERATIONS_ALERT_EMAIL: " ops@example.com " }).operationsAlertEmail)
      .toBe("ops@example.com");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const value of ["", "ops", "a@b.c,d@e.f", "a@b.c\nBcc: x@y.z"])
        expect(loadConfig({ ...baseEnv(), OPERATIONS_ALERT_EMAIL: value }).operationsAlertEmail).toBeNull();
      expect(warn).toHaveBeenCalledTimes(3);
    } finally { warn.mockRestore(); }
  });

  it.each(["49", "60001", "2.5", "bad"])("rejects an unbounded slow-request threshold %s", (value) => {
    expect(() => loadConfig({ ...baseEnv(), SLOW_REQUEST_LOG_MS: value })).toThrow();
  });

  it.each(["1", "2"])("reserves both lock and callback capacity alongside shared LISTEN (max %s)", max => {
    expect(() => loadConfig({ ...baseEnv(), DATABASE_POOL_MAX: max })).toThrow(/DATABASE_POOL_MAX/);
  });
  it("permits two runtime connections when the listener has its own pool", () => {
    expect(loadConfig({ ...baseEnv(), DATABASE_POOL_MAX: "2", DATABASE_LISTEN_URL: baseEnv().DATABASE_URL }).databasePoolMax).toBe(2);
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

function cloudEnv(): NodeJS.ProcessEnv {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  return {
    ...validEnv(),
    GITHUB_APP_PRIVATE_KEY: privateKey,
    CLOUD_WORKSPACES_ENABLED: "true",
    CLOUD_WORKSPACE_PROVIDER: "daytona",
    DAYTONA_API_KEY: "daytona-api-key-for-control-plane-tests",
    DAYTONA_SNAPSHOT_ID: "snap_immutable_123",
    ZEROS_CLOUD_SOURCE_COMMIT: "a".repeat(40),
  };
}

function cloudSetupEnv(): NodeJS.ProcessEnv {
  const setupKey = randomBytes(32).toString("base64url");
  return {
    ...cloudEnv(),
    CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "true",
    CLOUD_WORKSPACE_CONTROL_PLANE_URL: "https://api.example.test",
    DAYTONA_TOOLBOX_ORIGINS: "https://proxy.example.test",
    CLOUD_WORKSPACE_SECRET_KEY_V1: setupKey,
    CLOUD_WORKSPACE_OBJECT_KEY_V1: setupKey,
    CLOUD_WORKSPACE_OBJECT_STORE_DIRECTORY: "/var/lib/zeros/workspace-objects",
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

describe("cloud workspace backend configuration", () => {
  function boatEnv(): NodeJS.ProcessEnv {
    return {
      ...cloudEnv(),
      CLOUD_WORKSPACE_PROVIDER: "boat",
      DAYTONA_API_KEY: undefined,
      DAYTONA_SNAPSHOT_ID: undefined,
      BOAT_API_KEY: "boat-api-key-for-control-plane-tests",
      BOAT_ACCOUNT_SCOPE: "qualification-account",
      BOAT_BILLING_ORG: "team_0f5c2a9e-4b1d-4c8e-9a70-3d2b1e6f8c41",
      BOAT_SNAPSHOT_ID: "zeros-qualified-immutable-v1",
      BOAT_IMAGE_BUILD_SHA256: "c".repeat(64),
      BOAT_TTL_SECONDS: "3600",
      BOAT_COMPUTE_POLICY_ID: "boat-price-v1",
      BOAT_SECONDS_PER_DOLLAR: "100000",
      CLOUD_WORKSPACE_STORAGE_MIB: "40960",
    };
  }

  it("defaults the managed provider to Boat and never implies Daytona", () => {
    const cloud = loadConfig({ ...boatEnv(), CLOUD_WORKSPACE_PROVIDER: undefined }).cloudWorkspaces!;
    expect(cloud).toMatchObject({ provider: "boat", cpuMillicores: 4000, memoryMiB: 8192 });
    expect(cloud.providerProfiles).toBeUndefined();
    expect(cloud.daytonaConnection).toBeUndefined();
    // A Daytona credential alone neither selects Daytona nor satisfies Boat.
    expect(() => loadConfig({ ...cloudEnv(), CLOUD_WORKSPACE_PROVIDER: undefined })).toThrow(/BOAT_API_KEY/);
  });

  it("configures managed Boat without a managed Daytona credential", () => {
    const cloud = loadConfig(boatEnv()).cloudWorkspaces!;
    expect(cloud).toMatchObject({
      provider: "boat",
      apiKey: "boat-api-key-for-control-plane-tests",
      apiUrl: "https://boat.dev/api/v1",
      imageRef: `boat:zeros-qualified-immutable-v1@sha256:${"c".repeat(64)}`,
      architecture: "linux/amd64",
      cpuMillicores: 4000,
      memoryMiB: 8192,
      storageMiB: 40960,
      boat: {
        accountScope: "qualification-account",
        ttlSeconds: 3600,
        billingOrg: "team_0f5c2a9e-4b1d-4c8e-9a70-3d2b1e6f8c41",
      },
      computePolicy: {provider:"boat",policyId:"boat-price-v1",secondsPerDollar:100000,minimumTtlSeconds:600,maximumTtlSeconds:3600,requestMarginSeconds:185},
    });
    expect(cloud.providerProfiles).toBeUndefined();
    expect(cloud.daytonaConnection).toBeUndefined();
  });

  it("requires explicit Boat account, snapshot, TTL and measured capacity", () => {
    const env = boatEnv();
    for (const name of [
      "BOAT_API_KEY",
      "BOAT_ACCOUNT_SCOPE",
      "BOAT_BILLING_ORG",
      "BOAT_SNAPSHOT_ID",
      "BOAT_IMAGE_BUILD_SHA256",
      "BOAT_TTL_SECONDS",
      "BOAT_COMPUTE_POLICY_ID",
      "BOAT_SECONDS_PER_DOLLAR",
      "CLOUD_WORKSPACE_STORAGE_MIB",
    ]) {
      expect(() => loadConfig({ ...env, [name]: undefined })).toThrow(
        new RegExp(name),
      );
    }
    for (const overrides of [
      { BOAT_TTL_SECONDS: "0" },
      { BOAT_TTL_SECONDS: "3600junk" },
      { BOAT_TTL_SECONDS: "2592001" },
      { BOAT_TTL_SECONDS: "none" },
      { BOAT_TTL_SECONDS: "59" },
      { BOAT_TTL_SECONDS: "3601" },
      { BOAT_SECONDS_PER_DOLLAR: "0" },
      { BOAT_ACCOUNT_SCOPE: "key\nvalue" },
      { BOAT_BILLING_ORG: "Zeros" },
      { BOAT_BILLING_ORG: "team_" },
      { BOAT_BILLING_ORG: "team_0f5c2a9e-4b1d-4c8e-9a70-3d2b1e6f8c41\n" },
      { BOAT_BILLING_ORG: "71526620-8a69-44ca-bbef-1a71267c4350" },
      { BOAT_SNAPSHOT_ID: "mutable/latest" },
      { ZEROS_CLOUD_IMAGE_ARCHITECTURE: "linux/arm64" },
      { CLOUD_WORKSPACE_CPU_MILLICORES: "2000" },
    ])
      expect(() => loadConfig({ ...env, ...overrides })).toThrow(
        /cloud workspace/i,
      );
  });

  it("gives Daytona BYO an independent complete image profile beside managed Boat", () => {
    const env = {
      ...boatEnv(),
      DAYTONA_BYO_ENABLED: "true",
      DAYTONA_BYO_SNAPSHOT_ID: "daytona-qualified-image",
      DAYTONA_BYO_SOURCE_COMMIT: "b".repeat(40),
      DAYTONA_BYO_CPU_MILLICORES: "2000",
      DAYTONA_BYO_MEMORY_MIB: "4096",
      DAYTONA_BYO_STORAGE_MIB: "10240",
      DAYTONA_TARGET: "us",
    };
    const cloud = loadConfig(env).cloudWorkspaces!;
    expect(cloud.provider).toBe("boat");
    expect(cloud.daytonaConnection).toEqual({
      apiUrl: "https://app.daytona.io/api",
      target: "us",
    });
    expect(cloud.providerProfiles?.daytona).toEqual({
      provider: "daytona",
      imageRef: "daytona-qualified-image",
      sourceCommit: "b".repeat(40),
      architecture: "linux/amd64",
      cpuMillicores: 2000,
      memoryMiB: 4096,
      storageMiB: 10240,
    });
    for (const name of [
      "DAYTONA_BYO_SNAPSHOT_ID",
      "DAYTONA_BYO_SOURCE_COMMIT",
      "DAYTONA_BYO_CPU_MILLICORES",
      "DAYTONA_BYO_MEMORY_MIB",
      "DAYTONA_BYO_STORAGE_MIB",
    ]) {
      expect(() => loadConfig({ ...env, [name]: undefined })).toThrow(
        new RegExp(name),
      );
    }
    expect(() => loadConfig({ ...env, DAYTONA_BYO_ENABLED: "yes" })).toThrow(
      /DAYTONA_BYO_ENABLED/,
    );
  });

  it("allows Daytona credential onboarding without enabling its compute profile", () => {
    const cloud = loadConfig({
      ...boatEnv(),
      DAYTONA_CONNECTIONS_ENABLED: "true",
      DAYTONA_TARGET: "us",
      CLOUD_WORKSPACE_BACKGROUND_WORKERS_ENABLED: "false",
    }).cloudWorkspaces!;
    expect(cloud.daytonaConnection).toEqual({
      apiUrl: "https://app.daytona.io/api",
      target: "us",
    });
    expect(cloud.providerProfiles).toBeUndefined();
    expect(cloud.provider).toBe("boat");
    expect(configuredCloudWorkspaceProviders(cloud)).toEqual(["boat"]);
    expect(() => cloudWorkspaceProvisioningProfile(cloud, "daytona"))
      .toThrow("no valid provisioning profile");
    expect(cloud.backgroundWorkersEnabled).toBe(false);
    expect(cloud.setupExecution).toBeNull();
    expect(loadConfig({ ...boatEnv(), DAYTONA_CONNECTIONS_ENABLED: "false" })
      .cloudWorkspaces?.daytonaConnection).toBeUndefined();
    expect(() => loadConfig({ ...boatEnv(), DAYTONA_CONNECTIONS_ENABLED: "yes" }))
      .toThrow(/DAYTONA_CONNECTIONS_ENABLED/);
  });

  it("runs Boat setup without requiring Daytona toolbox access", () => {
    const cloud = loadConfig({
      ...cloudSetupEnv(),
      ...boatEnv(),
      DAYTONA_TOOLBOX_ORIGINS: undefined,
    }).cloudWorkspaces!;
    expect(cloud.setupExecution?.allowedToolboxOrigins).toEqual([]);
    expect(() =>
      loadConfig({
        ...cloudSetupEnv(),
        DAYTONA_TOOLBOX_ORIGINS: undefined,
      }),
    ).toThrow(/DAYTONA_TOOLBOX_ORIGINS/);
  });

  it("stays disabled unless the paid-resource gate is explicit", () => {
    expect(
      loadConfig({
        ...validEnv(),
        DAYTONA_API_KEY: "daytona-api-key-for-control-plane-tests",
        DAYTONA_SNAPSHOT_ID: "snap_immutable_123",
      }).cloudWorkspaces,
    ).toBeNull();
  });

  it("supports API replicas without implicitly starting cloud background work", () => {
    expect(loadConfig({...cloudEnv(), CLOUD_WORKSPACE_BACKGROUND_WORKERS_ENABLED:"false"}).cloudWorkspaces?.backgroundWorkersEnabled).toBe(false);
    expect(loadConfig(cloudEnv()).cloudWorkspaces?.backgroundWorkersEnabled).toBe(true);
    for(const enabled of ["true", "false"])expect(()=>loadConfig({...cloudEnv(), CLOUD_WORKSPACES_ENABLED:enabled, CLOUD_WORKSPACE_BACKGROUND_WORKERS_ENABLED:"typo"})).toThrow(/BACKGROUND_WORKERS_ENABLED/);
  });

  it("loads one pinned Daytona provider contract behind the gate", () => {
    expect(loadConfig(cloudEnv()).cloudWorkspaces).toEqual({
      provider: "daytona",
      apiKey: "daytona-api-key-for-control-plane-tests",
      apiUrl: "https://app.daytona.io/api",
      target: "eu",
      snapshotId: "snap_immutable_123",
      imageRef: "snap_immutable_123",
      architecture: "linux/amd64",
      cpuMillicores: 2_000,
      memoryMiB: 4_096,
      storageMiB: 20_480,
      sourceCommit: "a".repeat(40),
      operationTimeoutSeconds: 180,
      autoArchiveMinutes: 10_080,
      reconcileIntervalMs: 5_000,
      backgroundWorkersEnabled: true,
      access: {
        allowedSshHosts: ["ssh.app.daytona.io"],
        allowedPreviewHostSuffixes: ["proxy.daytona.work"],
        previewBaseDomain: null,
      },
      providerCredentialKeys: {},
      settingsSecretEncryptionKeys: {},
      currentSettingsSecretEncryptionKeyVersion: null,
      settingsSecretKeyV1: null,
      durability: null,
      outbox: null,
      setupExecution: null,
    });
  });

  it("loads only a complete HTTPS cloud event outbox sink", () => {
    expect(
      loadConfig({
        ...cloudEnv(),
        CLOUD_WORKSPACE_OUTBOX_URL:
          "https://events.example.test/v1/cloud-workspaces",
        CLOUD_WORKSPACE_OUTBOX_SIGNING_SECRET: "s".repeat(32),
        CLOUD_WORKSPACE_OUTBOX_TIMEOUT_MS: "12000",
      }).cloudWorkspaces?.outbox,
    ).toEqual({
      endpoint: "https://events.example.test/v1/cloud-workspaces",
      signingSecret: "s".repeat(32),
      timeoutMs: 12_000,
    });

    for (const override of [
      {
        CLOUD_WORKSPACE_OUTBOX_URL:
          "https://events.example.test/v1/cloud-workspaces",
      },
      { CLOUD_WORKSPACE_OUTBOX_SIGNING_SECRET: "s".repeat(32) },
      {
        CLOUD_WORKSPACE_OUTBOX_URL:
          "http://events.example.test/v1/cloud-workspaces",
        CLOUD_WORKSPACE_OUTBOX_SIGNING_SECRET: "s".repeat(32),
      },
      {
        CLOUD_WORKSPACE_OUTBOX_URL:
          "https://user:secret@events.example.test/v1/cloud-workspaces",
        CLOUD_WORKSPACE_OUTBOX_SIGNING_SECRET: "s".repeat(32),
      },
    ]) {
      expect(() => loadConfig({ ...cloudEnv(), ...override })).toThrow(
        /cloud workspace outbox/i,
      );
    }
  });

  it("pins provider access hosts and an isolated wildcard preview domain", () => {
    expect(
      loadConfig({
        ...cloudEnv(),
        DAYTONA_SSH_HOSTS:
          "ssh.provider.example,ssh-secondary.provider.example",
        DAYTONA_PREVIEW_HOST_SUFFIXES:
          "preview.provider.example,preview-alt.provider.example",
        CLOUD_WORKSPACE_PREVIEW_BASE_DOMAIN: "cloud-preview.example.test",
      }).cloudWorkspaces?.access,
    ).toEqual({
      allowedSshHosts: [
        "ssh.provider.example",
        "ssh-secondary.provider.example",
      ],
      allowedPreviewHostSuffixes: [
        "preview.provider.example",
        "preview-alt.provider.example",
      ],
      previewBaseDomain: "cloud-preview.example.test",
    });
  });

  it("rejects wildcard, URL, and IP-shaped provider access hosts", () => {
    for (const override of [
      { DAYTONA_SSH_HOSTS: "*.example.test" },
      { DAYTONA_PREVIEW_HOST_SUFFIXES: "https://preview.example.test" },
      { CLOUD_WORKSPACE_PREVIEW_BASE_DOMAIN: "127.0.0.1" },
    ]) {
      expect(() => loadConfig({ ...cloudEnv(), ...override })).toThrow(
        /cloud workspace environment/i,
      );
    }
  });

  it("keeps setup behind an independent complete image-qualification gate", () => {
    const setupKey = randomBytes(32).toString("base64url");
    expect(
      loadConfig({
        ...cloudSetupEnv(),
        DAYTONA_TOOLBOX_ORIGINS:
          "https://proxy-a.example.test,https://proxy-b.example.test",
        CLOUD_WORKSPACE_SECRET_KEY_V1: setupKey,
        CLOUD_WORKSPACE_OBJECT_KEY_V1: setupKey,
      }).cloudWorkspaces,
    ).toEqual({
      ...loadConfig(cloudEnv()).cloudWorkspaces,
      settingsSecretEncryptionKeys: { 1: setupKey },
      currentSettingsSecretEncryptionKeyVersion: 1,
      settingsSecretKeyV1: setupKey,
      durability: {
        objectEncryptionKeys: { 1: setupKey },
        currentObjectEncryptionKeyVersion: 1,
        objectRestoreWindowMs: 172_800_000,
        objectStoreDirectory: "/var/lib/zeros/workspace-objects",
      },
      setupExecution: {
        controlPlaneOrigin: "https://api.example.test",
        allowedToolboxOrigins: [
          "https://proxy-a.example.test",
          "https://proxy-b.example.test",
        ],
        setupSecretEncryptionKeys: { 1: setupKey },
        currentSetupSecretEncryptionKeyVersion: 1,
        setupSecretKeyV1: setupKey,
        engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
        enginePort: 39_393,
        engineHeartbeatIntervalMs: 10_000,
        intervalMs: 1_000,
        timeoutSeconds: 1_800,
        leaseMs: 60_000,
        admissionTtlSeconds: 120,
      },
    });
  });

  it("defaults cloud setup to the shared engine protocol while retaining an explicit compatible-image override", () => {
    expect(
      loadConfig(cloudSetupEnv()).cloudWorkspaces?.setupExecution
        ?.engineProtocolVersion,
    ).toBe(CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION);
    expect(
      loadConfig({
        ...cloudSetupEnv(),
        CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION: String(
          MIN_CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
        ),
      }).cloudWorkspaces?.setupExecution?.engineProtocolVersion,
    ).toBe(MIN_CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION);
  });

  it("bounds the engine heartbeat interval inside the lease", () => {
    const interval = (value: string) =>
      loadConfig({
        ...cloudSetupEnv(),
        CLOUD_WORKSPACE_ENGINE_HEARTBEAT_INTERVAL_MS: value,
      }).cloudWorkspaces?.setupExecution?.engineHeartbeatIntervalMs;
    expect(interval("30000")).toBe(30_000);
    expect(interval("5000")).toBe(5_000);
    for (const value of ["4999", "30001", "10000.5"])
      expect(() => interval(value)).toThrow(
        /CLOUD_WORKSPACE_ENGINE_HEARTBEAT_INTERVAL_MS/,
      );
  });

  it("keeps durable fork and recovery storage available while setup stays paused", () => {
    const objectKey = randomBytes(32).toString("base64url");
    const cloud = loadConfig({
      ...cloudEnv(),
      CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "false",
      CLOUD_WORKSPACE_OBJECT_KEY_V1: objectKey,
      CLOUD_WORKSPACE_OBJECT_STORE_DIRECTORY:
        "/var/lib/zeros/workspace-objects",
    }).cloudWorkspaces;
    expect(cloud?.setupExecution).toBeNull();
    expect(cloud?.durability).toEqual({
      objectEncryptionKeys: { 1: objectKey },
      currentObjectEncryptionKeyVersion: 1,
      objectRestoreWindowMs: 172_800_000,
      objectStoreDirectory: "/var/lib/zeros/workspace-objects",
    });
  });

  it("keeps objects for a bounded database restore window", () => {
    const window = (value?: string) => loadConfig({
      ...cloudEnv(),
      CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "false",
      CLOUD_WORKSPACE_OBJECT_KEY_V1: randomBytes(32).toString("base64url"),
      CLOUD_WORKSPACE_OBJECT_STORE_DIRECTORY: "/var/lib/zeros/workspace-objects",
      ...(value === undefined ? {} : { CLOUD_WORKSPACE_OBJECT_RESTORE_WINDOW_HOURS: value }),
    }).cloudWorkspaces?.durability?.objectRestoreWindowMs;
    expect(window()).toBe(48 * 3_600_000);
    expect(window("0")).toBe(0);
    expect(window(" ")).toBe(48 * 3_600_000);
    expect(window("168")).toBe(168 * 3_600_000);
    for (const value of ["-1", "721", "1.5"]) expect(() => window(value)).toThrow(/CLOUD_WORKSPACE_OBJECT_RESTORE_WINDOW_HOURS/);
  });

  it("keeps encrypted cloud settings available while setup stays paused", () => {
    const settingsKey = randomBytes(32).toString("base64url");
    const cloud = loadConfig({
      ...cloudEnv(),
      CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "false",
      CLOUD_WORKSPACE_SECRET_KEY_V1: settingsKey,
    }).cloudWorkspaces;

    expect(cloud?.settingsSecretKeyV1).toBe(settingsKey);
    expect(cloud?.setupExecution).toBeNull();
  });

  it("loads an explicit object-key rotation keyring without dropping V1", () => {
    const oldKey = randomBytes(32).toString("base64url");
    const newKey = randomBytes(32).toString("base64url");
    expect(
      loadConfig({
        ...cloudEnv(),
        CLOUD_WORKSPACE_OBJECT_KEY_V1: oldKey,
        CLOUD_WORKSPACE_OBJECT_KEYS_JSON: JSON.stringify({
          1: oldKey,
          2: newKey,
        }),
        CLOUD_WORKSPACE_OBJECT_CURRENT_KEY_VERSION: "2",
        CLOUD_WORKSPACE_OBJECT_STORE_DIRECTORY:
          "/var/lib/zeros/workspace-objects",
      }).cloudWorkspaces?.durability,
    ).toEqual({
      objectEncryptionKeys: { 1: oldKey, 2: newKey },
      currentObjectEncryptionKeyVersion: 2,
      objectRestoreWindowMs: 172_800_000,
      objectStoreDirectory: "/var/lib/zeros/workspace-objects",
    });
  });

  it("loads a versioned secret keyring and selects an explicit current key", () => {
    const oldKey = randomBytes(32).toString("base64url");
    const newKey = randomBytes(32).toString("base64url");
    const cloud = loadConfig({
      ...cloudEnv(),
      CLOUD_WORKSPACE_SECRET_KEY_V1: oldKey,
      CLOUD_WORKSPACE_SECRET_KEYS_JSON: JSON.stringify({
        1: oldKey,
        2: newKey,
      }),
      CLOUD_WORKSPACE_SECRET_CURRENT_KEY_VERSION: "2",
    }).cloudWorkspaces;

    expect(cloud?.settingsSecretEncryptionKeys).toEqual({
      1: oldKey,
      2: newKey,
    });
    expect(cloud?.currentSettingsSecretEncryptionKeyVersion).toBe(2);
  });

  it("rejects partial durability and missing rotation keys", () => {
    const objectKey = randomBytes(32).toString("base64url");
    expect(() =>
      loadConfig({
        ...cloudEnv(),
        CLOUD_WORKSPACE_OBJECT_KEY_V1: objectKey,
      }),
    ).toThrow(/CLOUD_WORKSPACE_OBJECT_STORE_DIRECTORY/);
    expect(() =>
      loadConfig({
        ...cloudEnv(),
        CLOUD_WORKSPACE_OBJECT_KEYS_JSON: JSON.stringify({ 1: objectKey }),
        CLOUD_WORKSPACE_OBJECT_CURRENT_KEY_VERSION: "2",
        CLOUD_WORKSPACE_OBJECT_STORE_DIRECTORY:
          "/var/lib/zeros/workspace-objects",
      }),
    ).toThrow(/current object key version/i);
  });

  it("configures shared encrypted objects without a local volume", () => {
    const env = cloudSetupEnv();
    delete env.CLOUD_WORKSPACE_OBJECT_STORE_DIRECTORY;
    Object.assign(env, {
      CLOUD_WORKSPACE_OBJECT_STORE_KIND: "s3",
      CLOUD_WORKSPACE_S3_ENDPOINT: "https://objects.example.test",
      CLOUD_WORKSPACE_S3_BUCKET: "workspace-objects",
      CLOUD_WORKSPACE_S3_ACCESS_KEY_ID: "access-for-tests",
      CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY: "secret-for-tests",
    });
    expect(loadConfig(env).cloudWorkspaces?.durability).toMatchObject({ s3: { bucket: "workspace-objects", region: "auto" } });
    for (const endpoint of ["http://objects.example.test", "https://objects.example.test/bucket", "https://name:password@objects.example.test", "https://objects.example.test/?signature=secret"]) {
      expect(() => loadConfig({ ...env, CLOUD_WORKSPACE_S3_ENDPOINT: endpoint })).toThrow();
    }
    expect(() => loadConfig({ ...env, CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY: "" })).toThrow();
    expect(() => loadConfig({ ...env, CLOUD_WORKSPACE_OBJECT_STORE_KIND: "filesystem" })).toThrow();
    expect(() => loadConfig({ ...env, CLOUD_WORKSPACE_OBJECT_STORE_DIRECTORY: "/data/objects" })).toThrow();
  });

  it("rejects partial or unsafe setup execution configuration", () => {
    expect(() =>
      loadConfig({
        ...cloudSetupEnv(),
        CLOUD_WORKSPACE_CONTROL_PLANE_URL: undefined,
      }),
    ).toThrow(/CLOUD_WORKSPACE_CONTROL_PLANE_URL/);
    expect(() =>
      loadConfig({
        ...cloudSetupEnv(),
        DAYTONA_TOOLBOX_ORIGINS: "https://proxy.example.test/path",
      }),
    ).toThrow(/DAYTONA_TOOLBOX_ORIGINS/);
    expect(() =>
      loadConfig({
        ...cloudSetupEnv(),
        CLOUD_WORKSPACE_SECRET_KEY_V1: "not-a-32-byte-key",
      }),
    ).toThrow(/exactly 32 bytes/);
    expect(() =>
      loadConfig({
        ...validEnv(),
        CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "true",
      }),
    ).toThrow(/requires CLOUD_WORKSPACES_ENABLED=true/);
  });

  it("fails boot when the explicit gate lacks provider or GitHub mint authority", () => {
    expect(() =>
      loadConfig({
        ...validEnv(),
        CLOUD_WORKSPACES_ENABLED: "true",
      }),
    ).toThrow(/BOAT_API_KEY/);

    const env = cloudEnv();
    delete env.GITHUB_APP_PRIVATE_KEY;
    expect(() => loadConfig(env)).toThrow(/GITHUB_APP_PRIVATE_KEY/);

    const wrongKey = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    expect(() =>
      loadConfig({ ...cloudEnv(), GITHUB_APP_PRIVATE_KEY: String(wrongKey) }),
    ).toThrow(/valid RSA private key/);
  });

  it("rejects credential-bearing provider URLs and ambiguous gate values", () => {
    expect(() =>
      loadConfig({
        ...cloudEnv(),
        DAYTONA_API_URL: "https://user:secret@app.daytona.io/api",
      }),
    ).toThrow(/DAYTONA_API_URL/);
    expect(() =>
      loadConfig({ ...validEnv(), CLOUD_WORKSPACES_ENABLED: "yes" }),
    ).toThrow(/must be true or false/);
    expect(() =>
      loadConfig({
        ...cloudEnv(),
        ZEROS_CLOUD_SOURCE_COMMIT: "a".repeat(41),
      }),
    ).toThrow(/ZEROS_CLOUD_SOURCE_COMMIT/);
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
