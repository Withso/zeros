import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  agentSmokeProviderCwd,
  agentSmokeProviderRuntimeEnvironment,
  agentSmokeRuntimeEnvironment,
  agentSmokeSkipReason,
  canonicalAgentSmokeWorkspace,
  installAgentSmokeRuntimeEnvironment,
} from "../agent-smoke-runtime-assets.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("live agent smoke runtime assets", () => {
  it("hands the bundled Claude and Codex runtimes to the compiled smoke gateway", () => {
    const resolved = agentSmokeProviderRuntimeEnvironment(
      {},
      "darwin",
      "arm64",
      (specifier) => {
        const paths: Record<string, string> = {
          "@anthropic-ai/claude-agent-sdk": "/deps/claude-sdk/sdk.mjs",
          "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude":
            "/deps/claude-runtime/claude",
          "@openai/codex/package.json": "/deps/codex/package.json",
        };
        const match = paths[specifier];
        if (!match) throw new Error(`unexpected module: ${specifier}`);
        return match;
      },
    );

    expect(resolved).toEqual({
      ZEROS_CLAUDE_CLI_PATH: "/deps/claude-runtime/claude",
      ZEROS_CODEX_CLI_PATH: "/deps/codex/bin/codex.js",
    });
  });

  it("binds only native Code runtime assets to the repository source", () => {
    expect(agentSmokeRuntimeEnvironment("/repo", "/runtime/node", {})).toEqual({
      ZEROS_PTY_HOST_RUNTIME: "/runtime/node",
      ZEROS_CURSOR_HOST_SCRIPT:
        "/repo/apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs",
      ZEROS_HOST_SUPERVISOR_RUNTIME: "/runtime/node",
      ZEROS_HOST_SUPERVISOR_SCRIPT:
        "/repo/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs",
    });
  });

  it("preserves an explicitly supplied host supervisor", () => {
    expect(
      agentSmokeRuntimeEnvironment("/repo", "/runtime/node", {
        ZEROS_HOST_SUPERVISOR_SCRIPT: "/packaged/host-supervisor.mjs",
      }).ZEROS_HOST_SUPERVISOR_SCRIPT,
    ).toBe("/packaged/host-supervisor.mjs");
  });

  it("pairs an Electron host with the same native supervisor runtime", () => {
    const electron = "/Applications/Zeros Dev.app/Contents/MacOS/Zeros Dev";
    expect(
      agentSmokeRuntimeEnvironment("/repo", "/runtime/node", {
        ZEROS_PTY_HOST_RUNTIME: electron,
        ZEROS_PTY_HOST_RUNTIME_ELECTRON: "1",
      }).ZEROS_HOST_SUPERVISOR_RUNTIME,
    ).toBe(electron);
  });

  it("does not build Design-agent ZSR assets before a native Code smoke", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["agents:smoke"]).toBe(
      "node scripts/agent-smoke.mjs",
    );
    expect(packageJson.scripts?.["cursor:smoke:stored-admission"]).toBe(
      "electron scripts/cursor-stored-admission-smoke.cjs",
    );
  });

  it("does not require any ZSR build output for native Code", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "agent-smoke-linux-"));
    const runtime = path.join(fixture, "node");
    const cursorHost = path.join(
      fixture,
      "apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs",
    );
    const hostSupervisor = path.join(
      fixture,
      "apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs",
    );
    try {
      await mkdir(path.dirname(cursorHost), { recursive: true });
      await mkdir(path.dirname(hostSupervisor), { recursive: true });
      await Promise.all([
        writeFile(runtime, ""),
        writeFile(cursorHost, ""),
        writeFile(hostSupervisor, ""),
      ]);

      expect(() =>
        installAgentSmokeRuntimeEnvironment(fixture, runtime, {}, "linux"),
      ).not.toThrow();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("does not misreport an unavailable provider probe as signed out", () => {
    expect(
      agentSmokeSkipReason({
        installed: true,
        authenticated: false,
        authenticationUnavailableReason: "provider probe timed out",
      }),
    ).toBe("authentication check unavailable: provider probe timed out");
  });

  it("keeps every provider cwd inside the canonical smoke workspace", () => {
    const workspace = path.resolve("/private/tmp/zeros-smoke-workspace");
    const cwd = agentSmokeProviderCwd(workspace, "Codex/../../outside");
    expect(path.relative(workspace, cwd)).toBe(
      path.join(".zeros-agent-smoke", "codex-outside"),
    );
    expect(path.relative(workspace, cwd).startsWith(".." + path.sep)).toBe(
      false,
    );
  });

  it("canonicalizes a temporary-workspace alias before Git owns it", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "agent-smoke-path-"));
    const physical = path.join(fixture, "physical");
    const alias = path.join(fixture, "alias");
    await mkdir(physical);
    await symlink(physical, alias, "dir");
    try {
      expect(canonicalAgentSmokeWorkspace(alias)).toBe(physical);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
