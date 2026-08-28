import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";

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

function cloudEnv(): NodeJS.ProcessEnv {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  return {
    ...validEnv(),
    GITHUB_APP_PRIVATE_KEY: privateKey,
    CLOUD_WORKSPACES_ENABLED: "true",
    DAYTONA_API_KEY: "daytona-api-key-for-control-plane-tests",
    DAYTONA_SNAPSHOT_ID: "snap_immutable_123",
    ZEROS_CLOUD_SOURCE_COMMIT: "a".repeat(40),
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
      apiKey: "workos-api-key-for-tests",
      cookiePassword: "cookie-password-for-testscookie-password-for-tests",
      webhookSecret: "webhook-secret-for-tests",
    });
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
  it("stays disabled unless the paid-resource gate is explicit", () => {
    expect(
      loadConfig({
        ...validEnv(),
        DAYTONA_API_KEY: "daytona-api-key-for-control-plane-tests",
        DAYTONA_SNAPSHOT_ID: "snap_immutable_123",
      }).cloudWorkspaces,
    ).toBeNull();
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
      access: {
        allowedSshHosts: ["ssh.app.daytona.io"],
        allowedPreviewHostSuffixes: ["proxy.daytona.work"],
        previewBaseDomain: null,
      },
      setupExecution: null,
    });
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
        ...cloudEnv(),
        CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "true",
        CLOUD_WORKSPACE_CONTROL_PLANE_URL: "https://api.example.test",
        DAYTONA_TOOLBOX_ORIGINS:
          "https://proxy-a.example.test,https://proxy-b.example.test",
        CLOUD_WORKSPACE_SECRET_KEY_V1: setupKey,
        CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION: "11",
      }).cloudWorkspaces?.setupExecution,
    ).toEqual({
      controlPlaneOrigin: "https://api.example.test",
      allowedToolboxOrigins: [
        "https://proxy-a.example.test",
        "https://proxy-b.example.test",
      ],
      setupSecretKeyV1: setupKey,
      engineProtocolVersion: 11,
      enginePort: 39_393,
      intervalMs: 1_000,
      timeoutSeconds: 1_800,
      leaseMs: 60_000,
      admissionTtlSeconds: 120,
    });
  });

  it("rejects partial or unsafe setup execution configuration", () => {
    expect(() =>
      loadConfig({
        ...cloudEnv(),
        CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "true",
      }),
    ).toThrow(/CLOUD_WORKSPACE_CONTROL_PLANE_URL/);
    expect(() =>
      loadConfig({
        ...cloudEnv(),
        CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "true",
        CLOUD_WORKSPACE_CONTROL_PLANE_URL: "https://api.example.test",
        DAYTONA_TOOLBOX_ORIGINS: "https://proxy.example.test/path",
        CLOUD_WORKSPACE_SECRET_KEY_V1: randomBytes(32).toString("base64url"),
        CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION: "11",
      }),
    ).toThrow(/DAYTONA_TOOLBOX_ORIGINS/);
    expect(() =>
      loadConfig({
        ...cloudEnv(),
        CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "true",
        CLOUD_WORKSPACE_CONTROL_PLANE_URL: "https://api.example.test",
        DAYTONA_TOOLBOX_ORIGINS: "https://proxy.example.test",
        CLOUD_WORKSPACE_SECRET_KEY_V1: "not-a-32-byte-key",
        CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION: "11",
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
    ).toThrow(/DAYTONA_API_KEY/);

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
