import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  devAuthProfilePath,
  loadDevAuthEnvironment,
  ensureDevAuthEnvironment,
} from "../dev-auth-profile.mjs";

const VALID_ALPHA_PROFILE = {
  AUTH_PROVIDER: "workos",
  AUTH_DESKTOP_CLIENT_ID: "client_desktop_alpha",
  AUTH_ISSUER: "https://api.workos.com/user_management/client_web_alpha",
  AUTH_JWKS_URL: "https://api.workos.com/sso/jwks/client_web_alpha",
  AUTH_AUDIENCE: "https://api-alpha.zeros.build",
  VITE_APP_BASE_URL: "https://app-alpha.zeros.build",
  VITE_CONTROL_PLANE_URL: "https://api-alpha.zeros.build",
};

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zeros-dev-auth-profile-"));
  temporaryRoots.push(root);
  return root;
}

function writeEnvFile(path: string, values: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`,
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("automatic Dev public configuration", () => {
  function response(env = VALID_ALPHA_PROFILE): Response {
    return Response.json({ version: 1, environment: "alpha", env });
  }

  it("bootstraps a fresh Mac once and reuses its private cache across worktrees and restarts", async () => {
    const homeDir = temporaryRoot();
    const fetchImpl = vi.fn(async () => response());
    const first = await ensureDevAuthEnvironment({
      homeDir,
      processEnv: {},
      fetchImpl,
    });
    expect(first.env).toEqual(VALID_ALPHA_PROFILE);
    expect(first.issue).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api-alpha.zeros.build/auth/desktop/dev-config",
      expect.objectContaining({ redirect: "error", credentials: "omit" }),
    );
    expect(statSync(devAuthProfilePath(homeDir)).mode & 0o777).toBe(0o600);
    for (let instance = 0; instance < 3; instance++) {
      expect(
        (await ensureDevAuthEnvironment({ homeDir, processEnv: {}, fetchImpl }))
          .env,
      ).toEqual(first.env);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refreshes a stale cache atomically without persisting a shell override or server secrets", async () => {
    const homeDir = temporaryRoot();
    writeEnvFile(devAuthProfilePath(homeDir), VALID_ALPHA_PROFILE);
    utimesSync(devAuthProfilePath(homeDir), new Date(0), new Date(0));
    const rotated = {
      ...VALID_ALPHA_PROFILE,
      AUTH_DESKTOP_CLIENT_ID: "client_rotated",
    };
    const fetchImpl = vi.fn(async () =>
      response({
        ...rotated,
        WORKOS_API_KEY: "server-only-fixture",
      } as typeof rotated),
    );
    const result = await ensureDevAuthEnvironment({
      homeDir,
      processEnv: { AUTH_DESKTOP_CLIENT_ID: "client_override" },
      fetchImpl,
    });
    expect(result.env.AUTH_DESKTOP_CLIENT_ID).toBe("client_override");
    expect(loadDevAuthEnvironment({ homeDir, processEnv: {} }).env).toEqual(
      rotated,
    );
    expect(readFileSync(devAuthProfilePath(homeDir), "utf8")).not.toContain(
      "server-only-fixture",
    );
  });

  it("keeps the last validated profile during an outage", async () => {
    const homeDir = temporaryRoot();
    writeEnvFile(devAuthProfilePath(homeDir), VALID_ALPHA_PROFILE);
    utimesSync(devAuthProfilePath(homeDir), new Date(0), new Date(0));
    const result = await ensureDevAuthEnvironment({
      homeDir,
      processEnv: {},
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(result.env).toEqual(VALID_ALPHA_PROFILE);
    expect(result.issue).toBeNull();
  });

  it.each([
    {
      ...VALID_ALPHA_PROFILE,
      VITE_CONTROL_PLANE_URL: "https://api.zeros.build",
    },
    {
      ...VALID_ALPHA_PROFILE,
      AUTH_ISSUER: "https://untrusted.example.test/issuer",
    },
    { ...VALID_ALPHA_PROFILE, AUTH_DESKTOP_CLIENT_ID: "client_web_alpha" },
  ])("rejects an unsafe downloaded profile without writing it", async (env) => {
    const homeDir = temporaryRoot();
    await expect(
      ensureDevAuthEnvironment({
        homeDir,
        processEnv: {},
        fetchImpl: async () => response(env),
      }),
    ).rejects.toThrow(/Alpha/);
    expect(existsSync(devAuthProfilePath(homeDir))).toBe(false);
  });

  it("refuses an unsafe shell override before installing downloaded defaults", async () => {
    const homeDir = temporaryRoot();
    await expect(
      ensureDevAuthEnvironment({
        homeDir,
        processEnv: { VITE_APP_BASE_URL: "https://app.zeros.build" },
        fetchImpl: async () => response(),
      }),
    ).rejects.toThrow(/Alpha/);
    expect(existsSync(devAuthProfilePath(homeDir))).toBe(false);
  });

  it("reports a fresh-install outage without echoing response bodies", async () => {
    const homeDir = temporaryRoot();
    await expect(
      ensureDevAuthEnvironment({
        homeDir,
        processEnv: {},
        fetchImpl: async () =>
          new Response("private-diagnostic", { status: 503 }),
      }),
    ).rejects.toThrow("Could not load Alpha sign-in configuration");
    expect(existsSync(devAuthProfilePath(homeDir))).toBe(false);
  });

  it("keeps a valid cache when the config connection drops during the body", async () => {
    const homeDir = temporaryRoot();
    const profilePath = devAuthProfilePath(homeDir);
    writeEnvFile(profilePath, VALID_ALPHA_PROFILE);
    const stale = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(profilePath, stale, stale);
    const result = await ensureDevAuthEnvironment({
      homeDir,
      processEnv: {},
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("connection interrupted"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    expect(result.cachedOffline).toBe(true);
    expect(result.env).toEqual(VALID_ALPHA_PROFILE);
  });
});

describe("shared Zeros Dev Alpha authentication profile", () => {
  it("supplies the same validated profile to independent worktrees", () => {
    const root = temporaryRoot();
    const homeDir = join(root, "home");
    writeEnvFile(devAuthProfilePath(homeDir), VALID_ALPHA_PROFILE);

    const first = loadDevAuthEnvironment({
      homeDir,
      processEnv: {},
    });
    const second = loadDevAuthEnvironment({
      homeDir,
      processEnv: {},
    });

    expect(first).toMatchObject({
      env: VALID_ALPHA_PROFILE,
      source: "shared",
      issue: null,
    });
    expect(second).toMatchObject({
      env: VALID_ALPHA_PROFILE,
      source: "shared",
      issue: null,
    });
  });

  it("keeps an explicit one-run environment override intentional", () => {
    const root = temporaryRoot();
    const homeDir = join(root, "home");
    writeEnvFile(devAuthProfilePath(homeDir), VALID_ALPHA_PROFILE);

    const fromEnvironment = loadDevAuthEnvironment({
      homeDir,
      processEnv: {
        AUTH_DESKTOP_CLIENT_ID: "client_desktop_environment",
      },
    });

    expect(fromEnvironment.env.AUTH_DESKTOP_CLIENT_ID).toBe(
      "client_desktop_environment",
    );
    expect(fromEnvironment.source).toBe("environment");
  });

  it("imports only public allowlisted values", () => {
    const root = temporaryRoot();
    const homeDir = join(root, "home");
    writeEnvFile(devAuthProfilePath(homeDir), {
      ...VALID_ALPHA_PROFILE,
      WORKOS_API_KEY: "must-never-reach-electron",
      WORKOS_ALPHA_WEB_API_KEY: "must-never-reach-electron",
      UNRELATED_VALUE: "must-never-reach-electron",
    });

    const result = loadDevAuthEnvironment({
      homeDir,
      processEnv: {},
    });

    expect(result.issue).toBeNull();
    expect(result.env).toEqual(VALID_ALPHA_PROFILE);
    expect(result.env).not.toHaveProperty("WORKOS_API_KEY");
    expect(result.env).not.toHaveProperty("WORKOS_ALPHA_WEB_API_KEY");
    expect(result.env).not.toHaveProperty("UNRELATED_VALUE");
  });

  it("fails closed for a cross-environment or incomplete effective profile", () => {
    const root = temporaryRoot();
    const homeDir = join(root, "home");
    writeEnvFile(devAuthProfilePath(homeDir), {
      ...VALID_ALPHA_PROFILE,
      VITE_APP_BASE_URL: "https://app.zeros.build",
    });

    expect(loadDevAuthEnvironment({ homeDir, processEnv: {} }).issue).toBe(
      "app_origin",
    );
    expect(
      loadDevAuthEnvironment({
        homeDir: join(root, "empty-home"),
        processEnv: { AUTH_PROVIDER: "workos" },
      }).issue,
    ).toBe("desktop_client_id");
  });

  it("reports unreadable profiles without exposing parser or file details", () => {
    const root = temporaryRoot();
    const homeDir = join(root, "home");
    const profilePath = devAuthProfilePath(homeDir);
    mkdirSync(profilePath, { recursive: true });

    expect(() => loadDevAuthEnvironment({ homeDir, processEnv: {} })).toThrow(
      `Could not read a valid Zeros Dev auth profile at ${profilePath}`,
    );
  });
});
