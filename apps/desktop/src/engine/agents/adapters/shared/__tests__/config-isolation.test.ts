import { describe, it, expect } from "vitest";

import {
  CONFIG_ROOT_ENV_VARS,
  preserveAmbientConfigRoots,
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
});

describe("buildSpawnEnvWithLoginPath", () => {
  it("routes through the guard — caller cannot isolate the config dir", async () => {
    const env = await buildSpawnEnvWithLoginPath({
      CODEX_HOME: "/tmp/evil",
      ANTHROPIC_API_KEY: "sk-test",
    });
    // Injected config-root override is stripped back to ambient...
    expect(env.CODEX_HOME).toBe(process.env.CODEX_HOME);
    expect(env.HOME).toBe(process.env.HOME);
    // ...while ordinary session env + a resolved PATH still flow through.
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(typeof env.PATH).toBe("string");
    expect(env.PATH).toContain("/");
  });
});
