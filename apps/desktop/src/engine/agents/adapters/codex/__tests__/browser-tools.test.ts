import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { McpServerRegistration } from "../../../types";
import {
  codexPromptRequestsBrowserSkill,
  codexBrowserThreadConfig,
  codexNativeBrowserUnavailableReason,
  injectCodexBrowserSkillInput,
  mergeCodexNativeBrowserMcp,
  resolveCodexNativeBrowserRuntime,
} from "../browser-tools";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Codex browser tool adapter", () => {
  it("fails closed for a contained macOS Browser runtime", () => {
    expect(
      codexNativeBrowserUnavailableReason({
        contained: true,
        platform: "darwin",
      }),
    ).toMatch(/cannot safely run inside the macOS containment boundary/i);
    expect(
      codexNativeBrowserUnavailableReason({
        contained: false,
        platform: "darwin",
      }),
    ).toBeNull();
    expect(
      codexNativeBrowserUnavailableReason({
        contained: true,
        platform: "linux",
      }),
    ).toBeNull();
  });

  it("injects the exact official Browser skill path for explicit web interaction", () => {
    const input = [
      {
        type: "text" as const,
        text: "Go to OpenAI and navigate through its public pages.",
        text_elements: [],
      },
    ];
    const skill = {
      name: "control-in-app-browser" as const,
      path: "/Users/me/.codex/plugins/cache/openai-bundled/browser/1/skills/control-in-app-browser/SKILL.md",
    };

    expect(codexPromptRequestsBrowserSkill(input)).toBe(true);
    expect(injectCodexBrowserSkillInput(input, skill)).toEqual([
      {
        ...input[0],
        text: "$control-in-app-browser Go to OpenAI and navigate through its public pages.",
      },
      { type: "skill", ...skill },
    ]);
    expect(
      codexPromptRequestsBrowserSkill([
        {
          type: "text",
          text: "Fix the browser-tab.tsx TypeScript error.",
          text_elements: [],
        },
      ]),
    ).toBe(false);
  });

  it("enables the official bundled Browser plugin for a native IAB binding", () => {
    expect(codexBrowserThreadConfig(true)).toEqual({
      "plugins.browser@openai-bundled.enabled": true,
    });
  });

  it("disables that plugin when Browser use is unavailable", () => {
    expect(codexBrowserThreadConfig(false)).toEqual({
      "plugins.browser@openai-bundled.enabled": false,
    });
  });

  it("registers the official node_repl MCP with an exact browser-client trust hash", async () => {
    const fixture = await nativeBrowserFixture();
    const runtime = await resolveCodexNativeBrowserRuntime({
      runtimeRoots: [fixture.runtimeRoot],
      pluginRoots: [fixture.pluginRoot],
      codexCliPath: fixture.codexCliPath,
      codexHome: fixture.codexHome,
      platform: process.platform,
      arch: process.arch,
    });

    expect(runtime?.pluginId).toBe("browser@openai-bundled");
    expect(runtime?.browserSkill).toEqual({
      name: "control-in-app-browser",
      path: join(
        fixture.pluginRoot,
        "skills",
        "control-in-app-browser",
        "SKILL.md",
      ),
    });
    expect(runtime?.mcpServer).toMatchObject({
      name: "node_repl",
      transport: "stdio",
      command: join(
        fixture.runtimeRoot,
        "bin",
        process.platform === "win32" ? "node_repl.exe" : "node_repl",
      ),
      args: [],
      startupTimeoutSec: 120,
      env: {
        BROWSER_USE_AVAILABLE_BACKENDS: "iab",
        BROWSER_USE_CODEX_APP_BUILD_FLAVOR: "prod",
        BROWSER_USE_CODEX_APP_VERSION: "26.803.61601",
        CODEX_CLI_PATH: fixture.codexCliPath,
        CODEX_HOME: fixture.codexHome,
        NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
        NODE_REPL_NODE_MODULE_DIRS: join(
          fixture.runtimeRoot,
          "lib",
          "node_modules",
        ),
        NODE_REPL_NODE_PATH: join(
          fixture.runtimeRoot,
          "bin",
          process.platform === "win32" ? "node.exe" : "node",
        ),
        NODE_REPL_TRUSTED_CODE_PATHS: [
          fixture.codexHome,
          join(fixture.runtimeRoot, "lib", "node_modules"),
        ].join(delimiter),
        NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER:
          "Control the in-app browser in conjunction with the Browser Plugin.",
        NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: createHash("sha256")
          .update(fixture.browserClient)
          .digest("hex"),
      },
    });
    expect(runtime?.mcpServer.name).not.toBe("zeros_browser");
  });

  it("honors the runtime paths declared by the official cua_node manifest", async () => {
    const fixture = await nativeBrowserFixture();
    const declaredRoot = join(fixture.runtimeRoot, "declared");
    const nodeReplPath = join(declaredRoot, "helpers", "node_repl");
    const nodePath = join(declaredRoot, "runtime", "node");
    const nodeModulesPath = join(declaredRoot, "modules");
    await mkdir(join(declaredRoot, "helpers"), { recursive: true });
    await mkdir(join(declaredRoot, "runtime"), { recursive: true });
    await mkdir(nodeModulesPath, { recursive: true });
    await writeFile(nodeReplPath, "fixture");
    await writeFile(nodePath, "fixture");
    await chmod(nodeReplPath, 0o755);
    await chmod(nodePath, 0o755);
    await writeFile(
      join(fixture.runtimeRoot, "manifest.json"),
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        node_repl_path: "declared/helpers/node_repl",
        node_path: "declared/runtime/node",
        node_modules: "declared/modules",
      }),
    );

    const runtime = await resolveCodexNativeBrowserRuntime({
      runtimeRoots: [fixture.runtimeRoot],
      pluginRoots: [fixture.pluginRoot],
      codexCliPath: fixture.codexCliPath,
      codexHome: fixture.codexHome,
      platform: process.platform,
      arch: process.arch,
    });

    expect(runtime?.mcpServer.command).toBe(nodeReplPath);
    expect(runtime?.mcpServer.env).toMatchObject({
      NODE_REPL_NODE_PATH: nodePath,
      NODE_REPL_NODE_MODULE_DIRS: nodeModulesPath,
    });
  });

  it("fails closed when the official helper or Browser plugin is incomplete", async () => {
    const fixture = await nativeBrowserFixture();
    await rm(join(fixture.pluginRoot, "scripts", "browser-client.mjs"));

    await expect(
      resolveCodexNativeBrowserRuntime({
        runtimeRoots: [fixture.runtimeRoot],
        pluginRoots: [fixture.pluginRoot],
        codexCliPath: fixture.codexCliPath,
        codexHome: fixture.codexHome,
        platform: process.platform,
        arch: process.arch,
      }),
    ).resolves.toBeNull();
  });

  it("rejects a lookalike Browser plugin that is not authored by OpenAI", async () => {
    const fixture = await nativeBrowserFixture();
    await writeFile(
      join(fixture.pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "browser",
        version: "26.803.61601",
        author: { name: "Example Corp" },
      }),
    );

    await expect(
      resolveCodexNativeBrowserRuntime({
        runtimeRoots: [fixture.runtimeRoot],
        pluginRoots: [fixture.pluginRoot],
        codexCliPath: fixture.codexCliPath,
        codexHome: fixture.codexHome,
        platform: process.platform,
        arch: process.arch,
      }),
    ).resolves.toBeNull();
  });

  it("replaces an untrusted node_repl registration and preserves unrelated MCP servers", async () => {
    const fixture = await nativeBrowserFixture();
    const runtime = await resolveCodexNativeBrowserRuntime({
      runtimeRoots: [fixture.runtimeRoot],
      pluginRoots: [fixture.pluginRoot],
      codexCliPath: fixture.codexCliPath,
      codexHome: fixture.codexHome,
      platform: process.platform,
      arch: process.arch,
    });
    expect(runtime).not.toBeNull();
    const configured: McpServerRegistration[] = [
      {
        name: "node_repl",
        transport: "stdio",
        command: "/tmp/untrusted-node-repl",
      },
      {
        name: "github",
        transport: "http",
        url: "https://example.test/mcp",
      },
    ];

    expect(mergeCodexNativeBrowserMcp(configured, runtime!)).toEqual([
      runtime!.mcpServer,
      configured[1],
    ]);
  });
});

async function nativeBrowserFixture(): Promise<{
  browserClient: string;
  codexCliPath: string;
  codexHome: string;
  pluginRoot: string;
  runtimeRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "zeros-codex-browser-"));
  tempRoots.push(root);
  const runtimeRoot = join(root, "cua_node");
  const codexHome = join(root, ".codex");
  const pluginRoot = join(
    codexHome,
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    "26.803.61601",
  );
  const binaryName =
    process.platform === "win32" ? "node_repl.exe" : "node_repl";
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const codexCliPath = join(
    root,
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  const browserClient = "export const browserClientFixture = true;\n";

  await mkdir(join(runtimeRoot, "bin"), { recursive: true });
  await mkdir(join(runtimeRoot, "lib", "node_modules"), { recursive: true });
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "scripts"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "control-in-app-browser"), {
    recursive: true,
  });
  await writeFile(
    join(runtimeRoot, "manifest.json"),
    JSON.stringify({ platform: process.platform, arch: process.arch }),
  );
  await writeFile(join(runtimeRoot, "bin", binaryName), "fixture");
  await writeFile(join(runtimeRoot, "bin", nodeName), "fixture");
  await writeFile(codexCliPath, "fixture");
  await chmod(join(runtimeRoot, "bin", binaryName), 0o755);
  await chmod(join(runtimeRoot, "bin", nodeName), 0o755);
  await chmod(codexCliPath, 0o755);
  await writeFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "browser",
      version: "26.803.61601",
      author: { name: "OpenAI" },
    }),
  );
  await writeFile(
    join(pluginRoot, "scripts", "browser-client.mjs"),
    browserClient,
  );
  await writeFile(
    join(pluginRoot, "skills", "control-in-app-browser", "SKILL.md"),
    "---\nname: control-in-app-browser\n---\n",
  );

  return { browserClient, codexCliPath, codexHome, pluginRoot, runtimeRoot };
}
