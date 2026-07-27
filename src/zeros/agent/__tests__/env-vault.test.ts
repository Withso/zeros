import { afterEach, describe, expect, it, vi } from "vitest";

import {
  envVaultAccount,
  envVaultNameError,
  LEGACY_ENV_SECRET_SENTINEL,
  mergeEnvVaultScopes,
  parseEnvVault,
  planLegacyEnvSecretMigration,
  serializeEnvVault,
} from "../env-vault";

describe("envVaultAccount", () => {
  it("uses the envvault:: namespace (distinct from legacy env:: and mcp::)", () => {
    expect(envVaultAccount({ kind: "user" })).toBe("envvault::user");
    expect(
      envVaultAccount({ kind: "repo", repoRoot: "/Users/dev/Documents/widgets" }),
    ).toBe("envvault::repo::/Users/dev/Documents/widgets");
  });

  it("normalizes the repo root so path aliases share one scope", () => {
    // Trailing slash + macOS /private alias both collapse to the settings-layer key.
    expect(envVaultAccount({ kind: "repo", repoRoot: "/Users/dev/widgets/" })).toBe(
      envVaultAccount({ kind: "repo", repoRoot: "/Users/dev/widgets" }),
    );
    expect(envVaultAccount({ kind: "repo", repoRoot: "/private/var/r" })).toBe(
      envVaultAccount({ kind: "repo", repoRoot: "/var/r" }),
    );
  });
});

describe("envVaultNameError", () => {
  it("accepts ordinary and secret-shaped names (secrets are the point)", () => {
    expect(envVaultNameError("NODE_ENV")).toBeNull();
    expect(envVaultNameError("CLOUDFLARE_API_TOKEN")).toBeNull();
    expect(envVaultNameError("_private")).toBeNull();
  });

  it("rejects malformed names", () => {
    expect(envVaultNameError("")).not.toBeNull();
    expect(envVaultNameError("1BAD")).not.toBeNull();
    expect(envVaultNameError("HAS SPACE")).not.toBeNull();
    expect(envVaultNameError("has-dash")).not.toBeNull();
  });

  it("rejects code-injection names — the engine's own list, so no drift", () => {
    for (const name of [
      "NODE_OPTIONS",
      "NODE_PATH",
      "PATH",
      "BASH_ENV",
      "GIT_SSH_COMMAND",
      "DYLD_INSERT_LIBRARIES",
      "LD_PRELOAD",
      "GIT_CONFIG_GLOBAL",
    ]) {
      expect(envVaultNameError(name), name).not.toBeNull();
    }
  });

  it("allows credential-redirect names (machine-owner trust, like the user layer)", () => {
    expect(envVaultNameError("HTTP_PROXY")).toBeNull();
    expect(envVaultNameError("ANTHROPIC_BASE_URL")).toBeNull();
  });
});

describe("serialize/parseEnvVault", () => {
  it("round-trips a map", () => {
    const vars = { FOO: "bar", CLOUDFLARE_API_TOKEN: "tok_123" };
    expect(parseEnvVault(serializeEnvVault(vars))).toEqual(vars);
  });

  it("tolerates null, malformed JSON, and wrong shapes", () => {
    expect(parseEnvVault(null)).toEqual({});
    expect(parseEnvVault("")).toEqual({});
    expect(parseEnvVault("not json")).toEqual({});
    expect(parseEnvVault('"a string"')).toEqual({});
    expect(parseEnvVault('{"vars":["FOO"]}')).toEqual({});
    expect(parseEnvVault('{"vars":null}')).toEqual({});
  });

  it("skips non-string values and dangerous/invalid names on READ (defense in depth)", () => {
    const raw = JSON.stringify({
      version: 1,
      vars: {
        OK: "yes",
        NODE_OPTIONS: "--require /tmp/evil.js", // hand-edited secrets.json
        "BAD NAME": "x",
        NUM: 42,
      },
    });
    expect(parseEnvVault(raw)).toEqual({ OK: "yes" });
  });
});

describe("mergeEnvVaultScopes", () => {
  it("repo scope (more specific) wins on a name collision", () => {
    expect(
      mergeEnvVaultScopes({ A: "user", B: "user" }, { B: "repo", C: "repo" }),
    ).toEqual({ A: "user", B: "repo", C: "repo" });
  });

  it("drops dangerous names from the merged result", () => {
    expect(
      mergeEnvVaultScopes({ PATH: "/evil" }, { OK: "1", LD_PRELOAD: "x" }),
    ).toEqual({ OK: "1" });
  });
});

describe("readEnvVaultForEdit", () => {
  // The editor read must distinguish "never stored" from "stored but
  // unreadable": every save writes the WHOLE scope map, so treating a failed
  // read as empty would let the next save destroy the stored variables.
  const importWithSecrets = async (mock: {
    getSecret: (account: string) => Promise<string | null>;
    hasSecret: (account: string) => Promise<boolean>;
  }) => {
    vi.resetModules();
    vi.doMock("../../../native/secrets", () => ({
      getSecret: mock.getSecret,
      hasSecret: mock.hasSecret,
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    }));
    return import("../env-vault");
  };

  afterEach(() => {
    vi.doUnmock("../../../native/secrets");
    vi.resetModules();
  });

  it("returns {} when the account was never stored", async () => {
    const mod = await importWithSecrets({
      getSecret: async () => null,
      hasSecret: async () => false,
    });
    await expect(mod.readEnvVaultForEdit({ kind: "user" })).resolves.toEqual(
      {},
    );
  });

  it("THROWS when the account exists but couldn't be decrypted (null + present)", async () => {
    const mod = await importWithSecrets({
      getSecret: async () => null, // secret-store swallows decrypt failures into null
      hasSecret: async () => true,
    });
    await expect(mod.readEnvVaultForEdit({ kind: "user" })).rejects.toThrow(
      /decrypt/,
    );
  });

  it("THROWS on a corrupt or unexpected payload instead of reading it as empty", async () => {
    for (const raw of ["not json", '{"version":2}', '{"vars":["FOO"]}']) {
      const mod = await importWithSecrets({
        getSecret: async () => raw,
        hasSecret: async () => true,
      });
      await expect(mod.readEnvVaultForEdit({ kind: "user" })).rejects.toThrow();
    }
  });

  it("reads a healthy payload", async () => {
    const mod = await importWithSecrets({
      getSecret: async () => serializeEnvVault({ FOO: "bar" }),
      hasSecret: async () => true,
    });
    await expect(mod.readEnvVaultForEdit({ kind: "user" })).resolves.toEqual({
      FOO: "bar",
    });
  });
});

describe("planLegacyEnvSecretMigration", () => {
  it("copies recoverable sentinel-backed values and clears their file rows", () => {
    const plan = planLegacyEnvSecretMigration(
      { LOCKED: LEGACY_ENV_SECRET_SENTINEL, PLAIN: "kept-in-file" },
      {},
      { LOCKED: "s3cret" },
    );
    expect(plan.copy).toEqual({ LOCKED: "s3cret" });
    expect(plan.removeFromFile).toEqual(["LOCKED"]);
    expect(plan.unrecovered).toEqual([]);
  });

  it("leaves plain [env] values alone — they still work through spawn-env", () => {
    const plan = planLegacyEnvSecretMigration({ PLAIN: "value" }, {}, {});
    expect(plan.copy).toEqual({});
    expect(plan.removeFromFile).toEqual([]);
    expect(plan.unrecovered).toEqual([]);
  });

  it("never clobbers a name the vault already holds (idempotent retries)", () => {
    const plan = planLegacyEnvSecretMigration(
      { LOCKED: LEGACY_ENV_SECRET_SENTINEL },
      { LOCKED: "newer-vault-value" },
      { LOCKED: "stale-legacy-value" },
    );
    expect(plan.copy).toEqual({});
    // The sentinel row is dead either way — still cleaned out of the file.
    expect(plan.removeFromFile).toEqual(["LOCKED"]);
    expect(plan.unrecovered).toEqual([]);
  });

  it("reports unrecoverable and vault-refused names instead of dropping them silently", () => {
    const plan = planLegacyEnvSecretMigration(
      {
        GONE: LEGACY_ENV_SECRET_SENTINEL,
        NODE_OPTIONS: LEGACY_ENV_SECRET_SENTINEL, // dangerous — vault refuses
      },
      {},
      { GONE: null, NODE_OPTIONS: "--require x" },
    );
    expect(plan.copy).toEqual({});
    expect(plan.removeFromFile.sort()).toEqual(["GONE", "NODE_OPTIONS"]);
    expect(plan.unrecovered.sort()).toEqual(["GONE", "NODE_OPTIONS"]);
  });
});
