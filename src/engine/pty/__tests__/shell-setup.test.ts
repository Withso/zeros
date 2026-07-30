import { describe, it, expect, afterEach } from "vitest";
import { buildPtyEnv } from "../shell-setup";

// Secrets that must NEVER reach a shell spawned for a remote client — including
// the URL/connection-string/agent forms whose KEY carries no secret marker (the
// reason a denylist is insufficient and we use an allowlist).
const PLANTED = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "GH_PAT",
  "MY_DB_PASSWORD", "ZEROS_RELAY_URL", "ZEROS_SECRETS_FILE", "AWS_SECRET_ACCESS_KEY",
  "NPM_TOKEN", "DATABASE_URL", "REDIS_URL", "MONGODB_URI", "SENTRY_DSN",
  "CLOUD_API_URL", "SLACK_WEBHOOK_URL", "SSH_AUTH_SOCK", "KUBECONFIG", "MYSQL_PWD",
  "npm_config__authToken",
];
const ENGINE_INTERNAL_SECRETS = [
  "ZEROS_GITHUB_TOKEN",
  "ZEROS_LOCAL_WS_TOKEN",
  "ZEROS_GIT_AUTH_SOCKET",
  "ZEROS_GIT_AUTH_CONTEXT",
  "ZEROS_GIT_AUTH_PROTOCOL",
  "ZEROS_GIT_AUTH_HOST",
  "ZEROS_GIT_AUTH_HELPER",
  "ZEROS_GIT_AUTH_ASKPASS",
  "ZEROS_REAL_GIT_PATH",
  "ZEROS_REAL_GH_PATH",
];

describe("buildPtyEnv env scrubbing (remote = allowlist)", () => {
  afterEach(() => {
    for (const k of [...PLANTED, ...ENGINE_INTERNAL_SECRETS, "MY_SAFE_VAR"]) {
      delete process.env[k];
    }
  });

  it("remote shells get ONLY allowlisted vars — every secret is dropped (incl. URL/agent forms)", () => {
    for (const k of PLANTED) process.env[k] = "sensitive";
    process.env.MY_SAFE_VAR = "nope"; // not on the allowlist
    const env = buildPtyEnv({ scrub: true });
    for (const k of PLANTED) expect(env[k], `${k} must be scrubbed`).toBeUndefined();
    // Allowlist semantics: even an innocuous unknown var is dropped — that's
    // what makes it robust against secret-bearing names we never anticipated.
    expect(env.MY_SAFE_VAR).toBeUndefined();
    // Core vars the shell needs survive, and the Zeros overrides apply.
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
    expect(env.TERM).toBe("xterm-256color");
    expect(env.ZEROS_TERMINAL).toBe("1");
  });

  it("local shells keep the full env (desktop parity)", () => {
    process.env.ANTHROPIC_API_KEY = "local-key";
    process.env.MY_SAFE_VAR = "keep";
    const env = buildPtyEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("local-key");
    expect(env.MY_SAFE_VAR).toBe("keep");
    expect(buildPtyEnv({ scrub: false }).ANTHROPIC_API_KEY).toBe("local-key");
  });

  it("never exposes engine-owned auth channels, even to a local shell", () => {
    for (const key of ENGINE_INTERNAL_SECRETS) {
      process.env[key] = "engine-secret";
    }
    const env = buildPtyEnv();
    for (const key of ENGINE_INTERNAL_SECRETS) {
      expect(env[key], `${key} must stay engine-private`).toBeUndefined();
    }
  });
});
