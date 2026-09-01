import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  agentSmokeProviderCwd,
  agentSmokeProviderRuntimeEnvironment,
  agentSmokeSkipReason,
  agentSmokeZsrEnvironment,
  canonicalAgentSmokeWorkspace,
  installAgentSmokeZsrEnvironment,
} from "../agent-smoke-zsr-assets.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("live agent smoke ZSR assets", () => {
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

  it("binds every gateway boundary asset to the repository build output", () => {
    expect(agentSmokeZsrEnvironment("/repo", "/runtime/node", {})).toEqual({
      ZEROS_PTY_HOST_RUNTIME: "/runtime/node",
      ZEROS_CURSOR_HOST_SCRIPT:
        "/repo/apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs",
      ZEROS_ZSR_SUPERVISOR_RUNTIME: "/runtime/node",
      ZEROS_ZSR_SUPERVISOR_SCRIPT: "/repo/binaries/zsr-supervisor.mjs",
      ZEROS_ZSR_CONTAINER_WORKER_SCRIPT:
        "/repo/binaries/zsr-container-worker.mjs",
      ZEROS_ZSR_ORBSTACK_CONTAINER_HOST_SCRIPT:
        "/repo/binaries/zsr-orbstack-container-host.mjs",
      ZEROS_ZSR_ORBSTACK_CLOUD_INIT:
        "/repo/binaries/zsr-orbstack-cloud-init.yaml",
      ZEROS_ZSR_MACOS_PROCESS_DOMAIN_HELPER:
        "/repo/binaries/zsr-macos-process-domain",
      ZEROS_ZSR_RIPGREP_PATH: "/repo/binaries/zsr-rg",
    });
  });

  it("preserves an explicitly supplied packaged asset", () => {
    expect(
      agentSmokeZsrEnvironment("/repo", "/runtime/node", {
        ZEROS_ZSR_SUPERVISOR_SCRIPT: "/packaged/supervisor.mjs",
      }).ZEROS_ZSR_SUPERVISOR_SCRIPT,
    ).toBe("/packaged/supervisor.mjs");
  });

  it("pairs an Electron host with the same Electron supervisor runtime", () => {
    const electron = "/Applications/Zeros Dev.app/Contents/MacOS/Zeros Dev";
    expect(
      agentSmokeZsrEnvironment("/repo", "/runtime/node", {
        ZEROS_PTY_HOST_RUNTIME: electron,
        ZEROS_PTY_HOST_RUNTIME_ELECTRON: "1",
      }).ZEROS_ZSR_SUPERVISOR_RUNTIME,
    ).toBe(electron);
  });

  it("builds the generated and native assets before the live smoke", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["agents:smoke"]).toBe(
      "pnpm build:zsr-supervisor && node scripts/agent-smoke.mjs",
    );
  });

  it("does not require Darwin-only helpers after a Linux asset build", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "agent-smoke-linux-"));
    const runtime = path.join(fixture, "node");
    const claudeRuntime = path.join(fixture, "claude");
    const codexRuntime = path.join(fixture, "codex.js");
    const cursorHost = path.join(
      fixture,
      "apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs",
    );
    const commonAssets = [
      "zsr-supervisor.mjs",
      "zsr-container-worker.mjs",
      "zsr-orbstack-container-host.mjs",
      "zsr-orbstack-cloud-init.yaml",
      "zsr-rg",
    ];
    try {
      await mkdir(path.dirname(cursorHost), { recursive: true });
      await mkdir(path.join(fixture, "binaries"), { recursive: true });
      await Promise.all([
        writeFile(runtime, ""),
        writeFile(claudeRuntime, ""),
        writeFile(codexRuntime, ""),
        writeFile(cursorHost, ""),
        ...commonAssets.map((leaf) =>
          writeFile(path.join(fixture, "binaries", leaf), ""),
        ),
      ]);

      expect(() =>
        installAgentSmokeZsrEnvironment(
          fixture,
          runtime,
          {
            ZEROS_CLAUDE_CLI_PATH: claudeRuntime,
            ZEROS_CODEX_CLI_PATH: codexRuntime,
          },
          "linux",
        ),
      ).not.toThrow();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("does not misreport an unavailable contained probe as signed out", () => {
    expect(
      agentSmokeSkipReason({
        installed: true,
        authenticated: false,
        authenticationUnavailableReason: "ZSR could not run the probe.",
      }),
    ).toBe("authentication check unavailable: ZSR could not run the probe.");
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
      expect(canonicalAgentSmokeWorkspace(alias)).toBe(
        await realpath(physical),
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
