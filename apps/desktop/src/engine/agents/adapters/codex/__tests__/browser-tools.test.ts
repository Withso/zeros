import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
    expect(runtime?.mcpServer.env).not.toHaveProperty(
      "NODE_REPL_TRUSTED_SERVICES",
    );
    expect(runtime?.mcpServer.name).not.toBe("zeros_browser");
  });

  it("registers the split Browser plugin's trusted browser service with node_repl", async () => {
    const fixture = await nativeBrowserFixture({ layout: "split" });
    const onUnavailable = vi.fn();
    const runtime = await resolveCodexNativeBrowserRuntime({
      runtimeRoots: [fixture.runtimeRoot],
      pluginRoots: [fixture.pluginRoot],
      codexCliPath: fixture.codexCliPath,
      codexHome: fixture.codexHome,
      platform: process.platform,
      arch: process.arch,
      onUnavailable,
    });

    expect(onUnavailable).not.toHaveBeenCalled();
    expect(runtime?.pluginRoot).toBe(fixture.pluginRoot);
    // The 26.1007 Browser client calls nodeRepl.rpc("browser", ...), which
    // node_repl only provides when NODE_REPL_TRUSTED_SERVICES names the
    // plugin's service. The client hash pin belongs to the older layout.
    expect(runtime?.mcpServer.env).toEqual({
      BROWSER_USE_AVAILABLE_BACKENDS: "iab",
      BROWSER_USE_CODEX_APP_BUILD_FLAVOR: "prod",
      BROWSER_USE_CODEX_APP_VERSION: "26.1007.21159",
      BROWSER_USE_TINYSKY_ENABLED: "0",
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
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
        browser: join(fixture.pluginRoot, "scripts", "browser-service.mjs"),
      }),
      NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER:
        "Control the in-app browser in conjunction with the Browser Plugin.",
    });
  });

  it("trusts a split plugin root outside CODEX_HOME so node_repl can import its service", async () => {
    const fixture = await nativeBrowserFixture({ layout: "split" });
    const external = join(dirname(fixture.codexHome), "external-browser");
    await cp(fixture.pluginRoot, external, { recursive: true });

    const runtime = await resolveCodexNativeBrowserRuntime({
      runtimeRoots: [fixture.runtimeRoot],
      pluginRoots: [external],
      codexCliPath: fixture.codexCliPath,
      codexHome: fixture.codexHome,
      platform: process.platform,
      arch: process.arch,
    });

    expect(runtime?.pluginRoot).toBe(external);
    expect(
      runtime?.mcpServer.env?.NODE_REPL_TRUSTED_CODE_PATHS?.split(delimiter),
    ).toEqual([
      fixture.codexHome,
      join(fixture.runtimeRoot, "lib", "node_modules"),
      external,
    ]);
    expect(
      JSON.parse(runtime?.mcpServer.env?.NODE_REPL_TRUSTED_SERVICES ?? "{}"),
    ).toEqual({ browser: join(external, "scripts", "browser-service.mjs") });
  });

  it("fails closed with a reason when a split Browser client has no trusted service", async () => {
    const fixture = await nativeBrowserFixture({ layout: "split" });
    await rm(join(fixture.pluginRoot, "scripts", "browser-service.mjs"));
    const onUnavailable = vi.fn();

    await expect(
      resolveCodexNativeBrowserRuntime({
        runtimeRoots: [fixture.runtimeRoot],
        pluginRoots: [fixture.pluginRoot],
        codexCliPath: fixture.codexCliPath,
        codexHome: fixture.codexHome,
        platform: process.platform,
        arch: process.arch,
        onUnavailable,
      }),
    ).resolves.toBeNull();
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith({
      code: "plugin-incomplete",
      version: "26.1007.21159",
      detail: expect.stringMatching(/browser-service\.mjs/),
    });
  });

  it("fails closed with a reason when the browser service does not export handleRpc", async () => {
    const fixture = await nativeBrowserFixture({ layout: "split" });
    await writeFile(
      join(fixture.pluginRoot, "scripts", "browser-service.mjs"),
      "export const unrelated = true;\n",
    );
    const onUnavailable = vi.fn();

    await expect(
      resolveCodexNativeBrowserRuntime({
        runtimeRoots: [fixture.runtimeRoot],
        pluginRoots: [fixture.pluginRoot],
        codexCliPath: fixture.codexCliPath,
        codexHome: fixture.codexHome,
        platform: process.platform,
        arch: process.arch,
        onUnavailable,
      }),
    ).resolves.toBeNull();
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith({
      code: "plugin-unsupported",
      version: "26.1007.21159",
      detail: expect.stringMatching(/handleRpc/),
    });
  });

  it("uses a later complete plugin root without reporting an earlier unsupported one", async () => {
    const fixture = await nativeBrowserFixture({ layout: "split" });
    const broken = join(dirname(fixture.codexHome), "broken-browser");
    await cp(fixture.pluginRoot, broken, { recursive: true });
    await rm(join(broken, "scripts", "browser-service.mjs"));
    const onUnavailable = vi.fn();

    const runtime = await resolveCodexNativeBrowserRuntime({
      runtimeRoots: [fixture.runtimeRoot],
      pluginRoots: [broken, fixture.pluginRoot],
      codexCliPath: fixture.codexCliPath,
      codexHome: fixture.codexHome,
      platform: process.platform,
      arch: process.arch,
      onUnavailable,
    });

    expect(runtime?.pluginRoot).toBe(fixture.pluginRoot);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("reports a missing runtime, plugin or CLI as unavailable rather than unsupported", async () => {
    const fixture = await nativeBrowserFixture({ layout: "split" });
    const onUnavailable = vi.fn();
    const base = {
      codexCliPath: fixture.codexCliPath,
      codexHome: fixture.codexHome,
      platform: process.platform,
      arch: process.arch,
      onUnavailable,
    };

    await resolveCodexNativeBrowserRuntime({
      ...base,
      runtimeRoots: [join(fixture.runtimeRoot, "missing")],
      pluginRoots: [fixture.pluginRoot],
    });
    expect(onUnavailable).toHaveBeenLastCalledWith({ code: "runtime-missing" });

    await resolveCodexNativeBrowserRuntime({
      ...base,
      runtimeRoots: [fixture.runtimeRoot],
      pluginRoots: [join(fixture.codexHome, "missing")],
    });
    expect(onUnavailable).toHaveBeenLastCalledWith({ code: "plugin-missing" });

    await resolveCodexNativeBrowserRuntime({
      ...base,
      codexCliPath: join(fixture.codexHome, "missing-codex"),
      runtimeRoots: [fixture.runtimeRoot],
      pluginRoots: [fixture.pluginRoot],
    });
    expect(onUnavailable).toHaveBeenLastCalledWith({
      code: "codex-cli-missing",
    });
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

  it("discovers the official materialized Browser skill when the cache omits it", async () => {
    const fixture = await nativeBrowserFixture();
    const materialized = join(fixture.codexHome, ".tmp/bundled-marketplaces/openai-bundled/plugins/browser");
    await cp(fixture.pluginRoot, materialized, { recursive: true });
    // Current Desktop completes the provider package when materializing it;
    // its cached source archive does not contain this installed skill.
    const cache = join(fixture.codexHome, "plugins/cache/openai-bundled/browser/current");
    await cp(fixture.pluginRoot, cache, { recursive: true });
    await rm(join(cache, "skills"), { recursive: true });
    await rm(join(fixture.pluginRoot, "skills"), { recursive: true });
    const runtime = await resolveCodexNativeBrowserRuntime({
      runtimeRoots: [fixture.runtimeRoot], codexCliPath: fixture.codexCliPath,
      codexHome: fixture.codexHome, platform: process.platform, arch: process.arch, env: {},
    });
    expect(runtime?.pluginRoot).toBe(materialized);
    expect(runtime?.browserSkill.path).toBe(join(materialized, "skills/control-in-app-browser/SKILL.md"));
    expect(runtime?.mcpServer.env?.BROWSER_USE_AVAILABLE_BACKENDS).toBe("iab");
  });

  it("fails closed when the official helper or Browser plugin is incomplete", async () => {
    const fixture = await nativeBrowserFixture();
    await rm(join(fixture.pluginRoot, "scripts", "browser-client.mjs"));
    const onUnavailable = vi.fn();

    await expect(
      resolveCodexNativeBrowserRuntime({
        runtimeRoots: [fixture.runtimeRoot],
        pluginRoots: [fixture.pluginRoot],
        codexCliPath: fixture.codexCliPath,
        codexHome: fixture.codexHome,
        platform: process.platform,
        arch: process.arch,
        onUnavailable,
      }),
    ).resolves.toBeNull();
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith({
      code: "plugin-incomplete",
      version: "26.803.61601",
      detail: expect.stringMatching(/browser-client\.mjs/),
    });
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
    const onUnavailable = vi.fn();

    await expect(
      resolveCodexNativeBrowserRuntime({
        runtimeRoots: [fixture.runtimeRoot],
        pluginRoots: [fixture.pluginRoot],
        codexCliPath: fixture.codexCliPath,
        codexHome: fixture.codexHome,
        platform: process.platform,
        arch: process.arch,
        onUnavailable,
      }),
    ).resolves.toBeNull();
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith({
      code: "plugin-missing",
    });
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

/** `legacy` is the 26.803 layout whose client node_repl trusted by hash;
 * `split` is the 26.1007 layout whose client reaches a trusted service. */
async function nativeBrowserFixture(
  options: { layout?: "legacy" | "split" } = {},
): Promise<{
  browserClient: string;
  codexCliPath: string;
  codexHome: string;
  pluginRoot: string;
  runtimeRoot: string;
}> {
  // The resolver reports realpaths; macOS tmpdir() sits behind /var -> /private/var.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zeros-codex-browser-")),
  );
  tempRoots.push(root);
  const split = options.layout === "split";
  const version = split ? "26.1007.21159" : "26.803.61601";
  const runtimeRoot = join(root, "cua_node");
  const codexHome = join(root, ".codex");
  const pluginRoot = join(
    codexHome,
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    version,
  );
  const binaryName =
    process.platform === "win32" ? "node_repl.exe" : "node_repl";
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const codexCliPath = join(
    root,
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  const browserClient = split
    ? [
        "export async function setupBrowserRuntime() {",
        '  if (typeof globalThis.nodeRepl?.rpc !== "function") {',
        '    throw new Error("Browser use requires a trusted Node REPL browser service");',
        "  }",
        "}",
        "",
      ].join("\n")
    : "export const browserClientFixture = true;\n";

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
      version,
      author: { name: "OpenAI" },
    }),
  );
  await writeFile(
    join(pluginRoot, "scripts", "browser-client.mjs"),
    browserClient,
  );
  if (split) {
    await writeFile(
      join(pluginRoot, "scripts", "browser-service.mjs"),
      "async function handle() {}\nexport{handle as handleRpc};\n",
    );
  }
  await writeFile(
    join(pluginRoot, "skills", "control-in-app-browser", "SKILL.md"),
    "---\nname: control-in-app-browser\n---\n",
  );

  return { browserClient, codexCliPath, codexHome, pluginRoot, runtimeRoot };
}
