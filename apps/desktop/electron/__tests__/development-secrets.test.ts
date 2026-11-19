import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ home: "", userData: "" }));
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => state.home }, homedir: () => state.home };
});
vi.mock("electron", () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/u, ""),
  },
}));

import { zerosChannelDataDir, zerosDataDir, zerosDevelopmentDataDir } from "../../src/engine/db/paths";
import { assertDevelopmentAdmission, sharedSecretsDirectory } from "../storage-identity";
import { getSecret, setSecret } from "../secret-store";

const realPlatform = process.platform;
const ENV = ["ZEROS_DEV", "ZEROS_CHANNEL", "ZEROS_INSTANCE", "ZEROS_LOCAL_DEVELOPMENT", "ZEROS_ISOLATE",
  "ZEROS_SHARED_SECRETS_DIR", "ZEROS_DATA_DIR", "ZEROS_LOCAL_LAYOUT"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-dev-secrets-"));
  Object.defineProperty(process, "platform", { value: "darwin" });
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(state.home, { recursive: true, force: true });
});

/** Boot one identity the way main does, then return where its secrets live. */
function boot(env: Record<string, string>, localDevelopment: boolean) {
  for (const key of ENV) delete process.env[key];
  Object.assign(process.env, { ZEROS_DEV: "1", ZEROS_CHANNEL: "dev" }, env);
  const shared = sharedSecretsDirectory({
    channel: "dev",
    localDevelopment,
    isolate: process.env.ZEROS_ISOLATE === "1",
    familyDataDir: zerosChannelDataDir(),
    hostedAccountDataDir: zerosDevelopmentDataDir("alpha"),
  });
  if (shared) process.env.ZEROS_SHARED_SECRETS_DIR = shared;
  state.userData = zerosDataDir();
  return shared ?? state.userData;
}

describe("development secret stores", () => {
  const familyRoot = () => path.join(state.home, "Library", "Application Support", "com.zeros.local");

  it("shares Local's provider store across checkouts and keeps ZEROS_ISOLATE private", () => {
    expect(boot({ ZEROS_INSTANCE: "a123456789abcdef" }, true)).toBe(familyRoot());
    expect(boot({ ZEROS_INSTANCE: "b123456789abcdef" }, true)).toBe(familyRoot());
    expect(boot({ ZEROS_INSTANCE: "a123456789abcdef", ZEROS_ISOLATE: "1" }, true))
      .toBe(path.join(familyRoot(), "instances", "a123456789abcdef"));
  });

  it("keeps electron:alpha's account store in its own instance and out of Local's", () => {
    expect(boot({ ZEROS_INSTANCE: "alpha" }, false)).toBe(state.userData);
    expect(state.userData).toBe(path.join(familyRoot(), "instances", "alpha"));
    setSecret("auth-session", "alpha-session");
    expect(fs.existsSync(path.join(familyRoot(), "instances", "alpha", "secrets.json"))).toBe(true);
    expect(fs.existsSync(path.join(familyRoot(), "secrets.json"))).toBe(false);

    boot({ ZEROS_INSTANCE: "a123456789abcdef" }, true);
    setSecret("anthropic-api-key", "local-key");
    expect(getSecret("auth-session")).toBeNull();

    boot({ ZEROS_INSTANCE: "alpha" }, false);
    expect(getSecret("anthropic-api-key")).toBeNull();
    expect(getSecret("auth-session")).toBe("alpha-session");

    boot({ ZEROS_INSTANCE: "a123456789abcdef", ZEROS_ISOLATE: "1" }, true);
    expect(getSecret("auth-session")).toBeNull();
    expect(getSecret("anthropic-api-key")).toBeNull();
  });

  it("lets hosted test identities reuse electron:alpha's sign-in, never Local's", () => {
    expect(boot({ ZEROS_INSTANCE: "design-owner-0123456789ab" }, false))
      .toBe(path.join(familyRoot(), "instances", "alpha"));
    expect(boot({}, false)).toBe(path.join(familyRoot(), "instances", "alpha"));
    expect(boot({ ZEROS_INSTANCE: "design-owner-0123456789ab", ZEROS_ISOLATE: "1" }, false)).toBe(
      path.join(familyRoot(), "instances", "design-owner-0123456789ab"),
    );
  });

  it("never shares a store in an installed channel", () => {
    for (const channel of ["alpha", "stable"] as const) {
      expect(sharedSecretsDirectory({ channel, localDevelopment: false, isolate: false,
        familyDataDir: "/data/x", hostedAccountDataDir: "/data/y" })).toBeUndefined();
    }
  });

  it("refuses account-free Local on a reserved identity", () => {
    for (const instance of ["alpha", "default"])
      expect(() => assertDevelopmentAdmission({ localDevelopment: true, instance })).toThrow(/reserved/);
    expect(() => assertDevelopmentAdmission({ localDevelopment: false, instance: "alpha" })).not.toThrow();
    expect(() => assertDevelopmentAdmission({ localDevelopment: true, instance: "a123456789abcdef" })).not.toThrow();
  });
});
