import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  devAuthProfilePath,
  loadDevAuthEnvironment,
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
