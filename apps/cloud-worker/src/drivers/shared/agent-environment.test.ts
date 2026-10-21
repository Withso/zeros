import { describe, expect, it } from "vitest";
import { agentEnvironment } from "./agent-environment";

const source = {
  PATH: "/fixture/bin", HOME: "/fixture/home", USER: "fixture", LANG: "C.UTF-8",
  LC_CTYPE: "C.UTF-8", TERM: "xterm", TMPDIR: "/tmp", SHELL: "/bin/sh",
  ZEROS_WORKER_TOKEN: "fixture-worker", CURSOR_API_KEY: "fixture-cursor",
  ANTHROPIC_AUTH_TOKEN: "fixture-claude", OPENAI_API_KEY: "fixture-openai",
  CLAUDE_CODE_OAUTH_TOKEN: "fixture-ambient-oauth", ANTHROPIC_API_KEY: "fixture-ambient-api-key",
  ANTHROPIC_BASE_URL: "https://example.invalid", ZEROS_CLOUD_PROXY_TOKEN: "fixture-ambient-proxy",
  NODE_OPTIONS: "--require fixture", GH_TOKEN: "fixture-ambient-github",
  GIT_CONFIG_COUNT: "9",
};

describe("native agent environment", () => {
  it.each([
    { agent: "codex" as const, token: "fixture-own" },
    { agent: "claude" as const, oauthToken: "fixture-own" },
    { agent: "claude" as const, apiKey: "fixture-own" },
    { agent: "cursor" as const, apiKey: "fixture-own" },
  ])("passes only runtime basics and $agent's own login", (login) => {
    const env = agentEnvironment(login, source);
    for (const name of ["PATH", "HOME", "USER", "LANG", "LC_CTYPE", "TERM", "TMPDIR", "SHELL"])
      expect(env[name] === source[name as keyof typeof source]).toBe(true);
    for (const name of ["ZEROS_WORKER_TOKEN", "OPENAI_API_KEY", "NODE_OPTIONS", "GH_TOKEN", "GIT_CONFIG_COUNT"])
      expect(name in env).toBe(false);
    const own = login.agent === "codex" ? ["ZEROS_CLOUD_PROXY_TOKEN"] : login.agent === "claude"
      ? ["oauthToken" in login ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"] : ["CURSOR_API_KEY"];
    for (const name of ["ZEROS_CLOUD_PROXY_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CURSOR_API_KEY"])
      expect(name in env).toBe(own.includes(name));
    expect(env[own[0]] === "fixture-own").toBe(true);
  });

  it("accepts Git/GH broker wiring only from the worker's explicit configuration", () => {
    const env = agentEnvironment({ agent: "codex", token: "fixture-own" }, source, {
      GIT_ASKPASS: "/worker/askpass", GH_CONFIG_DIR: "/worker/gh", ZEROS_WORKER_TOKEN: "fixture-denied",
    });
    expect(env.GIT_ASKPASS === "/worker/askpass").toBe(true);
    expect(env.GH_CONFIG_DIR === "/worker/gh").toBe(true);
    expect("GIT_CONFIG_COUNT" in env).toBe(false);
    expect("ZEROS_WORKER_TOKEN" in env).toBe(false);
  });
});
