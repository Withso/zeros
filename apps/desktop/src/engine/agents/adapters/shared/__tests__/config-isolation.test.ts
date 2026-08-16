import { describe, it, expect } from "vitest";

import {
  completeAgentSpawnEnv,
  CONFIG_ROOT_ENV_VARS,
  ENGINE_AUTHORITY_ENV_VARS,
  preserveAmbientConfigRoots,
  stripEngineAuthorityEnv,
} from "../config-isolation";
import { buildSpawnEnvWithLoginPath } from "../login-shell-path";

// Zeros must never point a spawned agent at an isolated
// config dir, or the agent silently stops loading the user's native MCP
// servers + repo rules. These tests lock that invariant in.

describe("preserveAmbientConfigRoots", () => {
  it("drops a config-root var that the caller tried to inject (ambient unset)", () => {
    // CODEX_HOME / CLAUDE_CONFIG_DIR are not part of a normal test env, so
    // an injected value must be stripped — the agent falls back to ~/.codex
    // and ~/.claude as the user expects.
    expect(process.env.CODEX_HOME).toBeUndefined();
    const out = preserveAmbientConfigRoots({
      CODEX_HOME: "/tmp/isolated",
      CLAUDE_CONFIG_DIR: "/tmp/isolated-claude",
    });
    expect(out.CODEX_HOME).toBeUndefined();
    expect(out.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("ignores an attempt to override HOME — keeps the ambient value", () => {
    const out = preserveAmbientConfigRoots({ HOME: "/tmp/fake-home" });
    expect(out.HOME).toBe(process.env.HOME);
    expect(out.HOME).not.toBe("/tmp/fake-home");
  });

  it("leaves non-config vars untouched", () => {
    const out = preserveAmbientConfigRoots({
      ANTHROPIC_API_KEY: "sk-test",
      CURSOR_MODEL: "composer-1",
      ZEROS_WORKTREE_PATH: "/repo/wt",
    });
    expect(out.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(out.CURSOR_MODEL).toBe("composer-1");
    expect(out.ZEROS_WORKTREE_PATH).toBe("/repo/wt");
  });

  it("does not mutate the input object", () => {
    const input = { CODEX_HOME: "/tmp/isolated", FOO: "bar" };
    preserveAmbientConfigRoots(input);
    expect(input.CODEX_HOME).toBe("/tmp/isolated");
    expect(input.FOO).toBe("bar");
  });

  it("guards every documented config-root var", () => {
    const injected = Object.fromEntries(
      CONFIG_ROOT_ENV_VARS.map((k) => [k, "/tmp/isolated"]),
    );
    const out = preserveAmbientConfigRoots(injected);
    for (const key of CONFIG_ROOT_ENV_VARS) {
      expect(out[key]).toBe(process.env[key]); // ambient (often undefined)
    }
  });

  it("also strips ambient and caller-injected engine authority", () => {
    const prior = process.env.ZEROS_LOCAL_WS_TOKEN;
    process.env.ZEROS_LOCAL_WS_TOKEN = "engine-secret";
    try {
      const out = preserveAmbientConfigRoots({
        ZEROS_LOCAL_WS_TOKEN: "caller-secret",
        ZEROS_CONTROL_FD: "3",
        ZEROS_DATA_DIR: "/private/state",
        ZEROS_WORKTREE_PATH: "/repo/wt",
      });
      expect(out.ZEROS_LOCAL_WS_TOKEN).toBeUndefined();
      expect(out.ZEROS_CONTROL_FD).toBeUndefined();
      expect(out.ZEROS_DATA_DIR).toBeUndefined();
      expect(out.ZEROS_WORKTREE_PATH).toBe("/repo/wt");
    } finally {
      if (prior === undefined) delete process.env.ZEROS_LOCAL_WS_TOKEN;
      else process.env.ZEROS_LOCAL_WS_TOKEN = prior;
    }
  });
});

describe("stripEngineAuthorityEnv", () => {
  it("removes every documented engine capability without mutating input", () => {
    const input: Record<string, string> = {
      ...Object.fromEntries(
        ENGINE_AUTHORITY_ENV_VARS.map((name) => [name, "secret"]),
      ),
      SAFE: "visible",
    };
    const out = stripEngineAuthorityEnv(input);
    for (const name of ENGINE_AUTHORITY_ENV_VARS) {
      expect(out[name]).toBeUndefined();
      expect(input[name]).toBe("secret");
    }
    expect(out.SAFE).toBe("visible");
  });

  it("drops future ZSR internals and Conductor authority by name pattern", () => {
    const out = stripEngineAuthorityEnv({
      ZEROS_ZSR_FUTURE_HELPER_PATH: "/private/helper",
      CONDUCTOR_WORKSPACE_TOKEN: "secret",
      CONDUCTOR_INTERNAL_CREDENTIAL: "secret",
      CONDUCTOR_PORT: "43123",
      ZEROS_WORKTREE_PATH: "/repo/worktree",
    });
    expect(out).toEqual({
      CONDUCTOR_PORT: "43123",
      ZEROS_WORKTREE_PATH: "/repo/worktree",
    });
  });
});

describe("buildSpawnEnvWithLoginPath", () => {
  it("treats a supplied child environment as complete", async () => {
    const prior = process.env.ZEROS_AMBIENT_SENTINEL;
    process.env.ZEROS_AMBIENT_SENTINEL = "must-not-cross";
    try {
      const env = await buildSpawnEnvWithLoginPath({
        HOME: "/private/home",
        CODEX_HOME: "/private/codex",
        PATH: "/trusted/bin",
        SAFE: "visible",
        ZEROS_LOCAL_WS_TOKEN: "engine-secret",
      });
      expect(env).toEqual({
        HOME: "/private/home",
        CODEX_HOME: "/private/codex",
        PATH: "/trusted/bin",
        SAFE: "visible",
      });
    } finally {
      if (prior === undefined) delete process.env.ZEROS_AMBIENT_SENTINEL;
      else process.env.ZEROS_AMBIENT_SENTINEL = prior;
    }
  });

  it("constructs ambient compatibility once at the gateway edge", () => {
    const env = completeAgentSpawnEnv({ SAFE: "visible" });
    expect(env.SAFE).toBe("visible");
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.ZEROS_LOCAL_WS_TOKEN).toBeUndefined();
  });
});
