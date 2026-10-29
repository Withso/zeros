import { createHash } from "node:crypto";
import {
  open,
  readFile,
  readdir,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

import type { McpServerRegistration } from "../../types";
import type { CodexUserInput } from "./app-server";
import type { NativeDeclarationAllowance } from "./native-mcp";

/** The one plugin whose enablement `codexBrowserThreadConfig` owns. Exported
 * so the native-MCP scoping can leave that key alone instead of contending
 * with it inside one merged thread config. */
export const BROWSER_PLUGIN_ID = "browser@openai-bundled";
const MAX_BROWSER_CLIENT_BYTES = 16 * 1024 * 1024;
const MAX_BROWSER_SERVICE_BYTES = 64 * 1024 * 1024;
const BROWSER_INSTRUCTIONS =
  "Control the in-app browser in conjunction with the Browser Plugin.";

/** The official macOS Browser helper applies its own Seatbelt profile. A
 * process that already carries the optional deny-bearing kernel profile cannot
 * apply that nested profile, while moving the helper outside the selected
 * boundary would turn its mutable plugin code into a filesystem-authority
 * escape. Native Code sessions have no such nesting conflict. */
export function codexNativeBrowserUnavailableReason(options: {
  contained: boolean;
  platform?: NodeJS.Platform;
}): string | null {
  if (
    options.contained &&
    (options.platform ?? process.platform) === "darwin"
  ) {
    return "Official Browser cannot safely run inside the macOS containment boundary";
  }
  return null;
}

export interface CodexNativeBrowserRuntime {
  pluginId: typeof BROWSER_PLUGIN_ID;
  pluginRoot: string;
  /** The CODEX_HOME given to node_repl. */
  codexHome: string;
  browserSkill: CodexNativeBrowserSkill;
  mcpServer: Extract<McpServerRegistration, { transport: "stdio" }>;
}

export interface CodexNativeBrowserSkill {
  /** SKILL.md frontmatter name. The plugin qualification belongs to the `$`
   * marker; app-server's typed skill item uses this unqualified identity. */
  name: "control-in-app-browser";
  path: string;
}

/** Why no Browser runtime was registered. Only the plugin-* codes describe an
 * installed OpenAI plugin that Zeros could not use; the others mean ChatGPT or
 * Codex Desktop is simply absent. */
export type CodexNativeBrowserUnavailable =
  | { code: "codex-cli-missing" }
  | { code: "runtime-missing" }
  | { code: "plugin-missing" }
  | {
      code: "plugin-incomplete" | "plugin-unsupported";
      version: string;
      detail: string;
    };

export interface ResolveCodexNativeBrowserRuntimeOptions {
  runtimeRoots?: readonly string[];
  pluginRoots?: readonly string[];
  codexCliPath?: string;
  codexHome?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: Record<string, string | undefined>;
  /** Receives the reason once when the result is null. */
  onUnavailable?: (reason: CodexNativeBrowserUnavailable) => void;
}

/** The official Codex Browser plugin is the only browser surface exposed to
 * Codex. The feature gates are thread-scoped and do not mutate config.toml. */
export function codexBrowserThreadConfig(
  nativeBrowserAvailable: boolean,
): Record<string, boolean> {
  if (!nativeBrowserAvailable) {
    return { "plugins.browser@openai-bundled.enabled": false };
  }
  return {
    "plugins.browser@openai-bundled.enabled": true,
  };
}

/** Locate—not copy—the official Browser plugin and OpenAI node_repl runtime.
 * ChatGPT/Codex Desktop installs these outside the public @openai/codex CLI
 * package. If either half is absent or malformed we fail closed and leave the
 * Browser plugin disabled instead of substituting Zeros tools. */
export async function resolveCodexNativeBrowserRuntime(
  options: ResolveCodexNativeBrowserRuntimeOptions = {},
): Promise<CodexNativeBrowserRuntime | null> {
  const unavailable = (reason: CodexNativeBrowserUnavailable): null => {
    options.onUnavailable?.(reason);
    return null;
  };
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const codexHome = resolve(
    options.codexHome?.trim() ||
      env.CODEX_HOME?.trim() ||
      join(homedir(), ".codex"),
  );
  const codexCliPath =
    options.codexCliPath?.trim() || env.ZEROS_CODEX_CLI_PATH?.trim();
  if (!codexCliPath || !isAbsolute(codexCliPath)) {
    return unavailable({ code: "codex-cli-missing" });
  }
  const trustedCodexCli = await regularFile(codexCliPath);
  if (!trustedCodexCli) return unavailable({ code: "codex-cli-missing" });

  const runtimeRoots = options.runtimeRoots
    ? [...options.runtimeRoots]
    : await defaultRuntimeRoots(platform, env);
  const pluginRoots = options.pluginRoots
    ? [...options.pluginRoots]
    : await defaultBrowserPluginRoots(codexHome, env);

  let runtime: Awaited<ReturnType<typeof inspectRuntime>> = null;
  for (const runtimeCandidate of runtimeRoots) {
    runtime = await inspectRuntime(runtimeCandidate, platform, arch);
    if (runtime) break;
  }
  if (!runtime) return unavailable({ code: "runtime-missing" });

  let firstProblem: CodexNativeBrowserUnavailable | undefined;
  for (const pluginCandidate of pluginRoots) {
    const inspection = await inspectBrowserPlugin(pluginCandidate);
    if (inspection.kind === "missing") continue;
    if (inspection.kind !== "ready") {
      firstProblem ??= {
        code:
          inspection.kind === "incomplete"
            ? "plugin-incomplete"
            : "plugin-unsupported",
        version: inspection.version,
        detail: inspection.detail,
      };
      continue;
    }
    const plugin = inspection.plugin;
    return {
      pluginId: BROWSER_PLUGIN_ID,
      pluginRoot: plugin.root,
      codexHome,
      browserSkill: {
        name: "control-in-app-browser",
        path: plugin.browserSkillPath,
      },
      mcpServer: {
        name: "node_repl",
        transport: "stdio",
        command: runtime.nodeReplPath,
        args: [],
        // ChatGPT Desktop can declare node_repl itself; its arguments and
        // inherited variables never reach the verified runtime.
        replaceNativeLists: true,
        startupTimeoutSec: 120,
        env: await nodeReplBrowserEnv({
          codexCliPath: trustedCodexCli,
          codexHome,
          plugin,
          runtime,
        }),
      },
    };
  }
  return unavailable(firstProblem ?? { code: "plugin-missing" });
}

/** The 26.803 plugin ran its client in the kernel and node_repl pinned that
 * client by hash. From 26.1007 the client calls nodeRepl.rpc("browser"), which
 * node_repl only defines when NODE_REPL_TRUSTED_SERVICES names a service; its
 * trusted host then imports the service only from NODE_REPL_TRUSTED_CODE_PATHS.
 * The values mirror what ChatGPT Desktop passes for its own Browser. */
async function nodeReplBrowserEnv(options: {
  codexCliPath: string;
  codexHome: string;
  plugin: BrowserPlugin;
  runtime: NonNullable<Awaited<ReturnType<typeof inspectRuntime>>>;
}): Promise<Record<string, string>> {
  const { codexHome, plugin, runtime } = options;
  const trustedCodePaths = [codexHome, runtime.nodeModulesPath];
  const common = {
    BROWSER_USE_AVAILABLE_BACKENDS: "iab",
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: "prod",
    BROWSER_USE_CODEX_APP_VERSION: plugin.version,
    CODEX_CLI_PATH: options.codexCliPath,
    CODEX_HOME: codexHome,
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
    NODE_REPL_NODE_MODULE_DIRS: runtime.nodeModulesPath,
    NODE_REPL_NODE_PATH: runtime.nodePath,
    NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER: BROWSER_INSTRUCTIONS,
  };
  if (plugin.trust.kind === "client-sha256") {
    return {
      ...common,
      NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: plugin.trust.sha256,
      NODE_REPL_TRUSTED_CODE_PATHS: trustedCodePaths.join(delimiter),
    };
  }
  // Plugin roots are realpaths; CODEX_HOME may still be spelled through a
  // symlink, so compare against both spellings before widening trust.
  const realCodexHome = await directory(codexHome);
  const covered = [...trustedCodePaths, realCodexHome].some(
    (root) => root && (root === plugin.root || isInside(root, plugin.root)),
  );
  if (!covered) trustedCodePaths.push(plugin.root);
  return {
    ...common,
    BROWSER_USE_TINYSKY_ENABLED: "0",
    NODE_REPL_TRUSTED_CODE_PATHS: trustedCodePaths.join(delimiter),
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
      browser: plugin.trust.servicePath,
    }),
  };
}

const NODE_REPL_INSTRUCTIONS = /^NODE_REPL_INSTRUCTIONS_USE_CASE_[A-Z0-9_]{1,64}$/;

/** What ChatGPT/Codex Desktop's own `[mcp_servers.node_repl]` in the user's
 * `$CODEX_HOME/config.toml` may add to Zeros' verified runtime. Zeros' values
 * win every key it sets and replace the argument/variable lists, so only these
 * remain, and each is inert under Zeros' browser-only trust:
 *   • use-case instruction text for use cases Zeros does not enable;
 *   • a bounded per-tool timeout;
 *   • SKY_CUA_SERVICE_PATH equal to the default the CUA client derives from
 *     CODEX_HOME anyway ("<CODEX_HOME>/computer-use/Codex Computer Use.app"),
 *     read only when a computer-use call starts that helper.
 * Anything else, including trust lists, Node options or another service path,
 * keeps the conflict. Holds for every user's own CODEX_HOME. */
export function codexNativeBrowserDeclarationAllowance(options: {
  codexHome?: string;
}): NativeDeclarationAllowance {
  const computerUse = options.codexHome
    ? join(options.codexHome, "computer-use", "Codex Computer Use.app")
    : undefined;
  return {
    serverName: "node_repl",
    acceptsUserKey(path, value) {
      if (path.length === 1)
        return (
          path[0] === "tool_timeout_sec" &&
          typeof value === "number" &&
          Number.isInteger(value) &&
          value > 0 &&
          value <= 3_600
        );
      if (path.length !== 2 || path[0] !== "env" || typeof value !== "string")
        return false;
      if (NODE_REPL_INSTRUCTIONS.test(path[1])) return value.length <= 32_768;
      return path[1] === "SKY_CUA_SERVICE_PATH" && computerUse !== undefined && value === computerUse;
    },
  };
}

/** `node_repl` is an official Codex MCP dependency, but its name is also a
 * security boundary. Replace any workspace registration with the verified
 * OpenAI binary so the Browser plugin cannot be redirected to another server. */
export function mergeCodexNativeBrowserMcp(
  configured: readonly McpServerRegistration[],
  runtime: CodexNativeBrowserRuntime,
): McpServerRegistration[] {
  return [
    runtime.mcpServer,
    ...configured.filter((server) => server.name !== runtime.mcpServer.name),
  ];
}

async function defaultRuntimeRoots(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const roots: string[] = [];
  pushCandidate(roots, env.ZEROS_CODEX_CUA_NODE_ROOT);
  pushCandidate(
    roots,
    env.ZEROS_RESOURCES_PATH
      ? join(env.ZEROS_RESOURCES_PATH, "cua_node")
      : undefined,
  );
  if (platform === "darwin") {
    roots.push(
      "/Applications/ChatGPT.app/Contents/Resources/cua_node",
      "/Applications/Codex.app/Contents/Resources/cua_node",
      join(
        homedir(),
        "Applications",
        "ChatGPT.app",
        "Contents",
        "Resources",
        "cua_node",
      ),
      join(
        homedir(),
        "Applications",
        "Codex.app",
        "Contents",
        "Resources",
        "cua_node",
      ),
    );
  } else if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      const runtimes = join(
        localAppData,
        "OpenAI",
        "Codex",
        "runtimes",
        "cua_node",
      );
      roots.push(...(await childDirectoriesNewestFirst(runtimes)));
    }
  }
  return uniquePaths(roots);
}

async function defaultBrowserPluginRoots(
  codexHome: string,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const roots: string[] = [];
  pushCandidate(roots, env.ZEROS_CODEX_BROWSER_PLUGIN_ROOT);
  // Current Desktop materializes the runnable skill here. Its cache archive
  // can contain browser-client.mjs without the injected Browser SKILL.md.
  // Keep the same manifest, realpath and exact-client-hash checks below.
  roots.push(join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "browser"));
  const cacheRoot = join(
    codexHome,
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
  );
  roots.push(join(cacheRoot, "latest"));
  roots.push(...(await childDirectoriesNewestFirst(cacheRoot)));
  return uniquePaths(roots);
}

async function inspectRuntime(
  candidate: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<{
  nodeModulesPath: string;
  nodePath: string;
  nodeReplPath: string;
} | null> {
  const root = await directory(candidate);
  if (!root) return null;
  const manifest = await readJsonObject(join(root, "manifest.json"));
  if (!manifest || manifest.platform !== platform || manifest.arch !== arch) {
    return null;
  }
  const executableSuffix = platform === "win32" ? ".exe" : "";
  const nodeReplPath = await regularFileInside(
    root,
    resolve(
      root,
      runtimeManifestPath(
        manifest,
        "node_repl_path",
        join("bin", `node_repl${executableSuffix}`),
      ),
    ),
  );
  const nodePath = await regularFileInside(
    root,
    resolve(
      root,
      runtimeManifestPath(
        manifest,
        "node_path",
        join("bin", `node${executableSuffix}`),
      ),
    ),
  );
  const nodeModulesPath = await directoryInside(
    root,
    resolve(
      root,
      runtimeManifestPath(
        manifest,
        "node_modules",
        join("lib", "node_modules"),
      ),
    ),
  );
  if (!nodeReplPath || !nodePath || !nodeModulesPath) return null;
  return { nodeModulesPath, nodePath, nodeReplPath };
}

function runtimeManifestPath(
  manifest: Record<string, unknown>,
  key: "node_repl_path" | "node_path" | "node_modules",
  fallback: string,
): string {
  const declared = manifest[key];
  return typeof declared === "string" && declared.trim()
    ? declared.trim()
    : fallback;
}

interface BrowserPlugin {
  browserSkillPath: string;
  root: string;
  trust:
    | { kind: "client-sha256"; sha256: string }
    | { kind: "service"; servicePath: string };
  version: string;
}

type BrowserPluginInspection =
  | { kind: "missing" }
  | { kind: "incomplete" | "unsupported"; version: string; detail: string }
  | { kind: "ready"; plugin: BrowserPlugin };

async function inspectBrowserPlugin(
  candidate: string,
): Promise<BrowserPluginInspection> {
  const root = await directory(candidate);
  if (!root) return { kind: "missing" };
  const manifest = await readJsonObject(
    join(root, ".codex-plugin", "plugin.json"),
  );
  const author =
    manifest?.author &&
    typeof manifest.author === "object" &&
    !Array.isArray(manifest.author)
      ? (manifest.author as Record<string, unknown>).name
      : null;
  if (
    manifest?.name !== "browser" ||
    author !== "OpenAI" ||
    typeof manifest.version !== "string" ||
    manifest.version.length === 0 ||
    manifest.version.length > 128
  ) {
    return { kind: "missing" };
  }
  const version = manifest.version;
  const incomplete = (detail: string): BrowserPluginInspection => ({
    kind: "incomplete",
    version,
    detail,
  });
  const browserClientPath = await regularFileInside(
    root,
    join(root, "scripts", "browser-client.mjs"),
  );
  if (!browserClientPath) {
    return incomplete("scripts/browser-client.mjs is missing");
  }
  const browserSkillPath = await regularFileInside(
    root,
    join(root, "skills", "control-in-app-browser", "SKILL.md"),
  );
  if (!browserSkillPath) {
    return incomplete("skills/control-in-app-browser/SKILL.md is missing");
  }
  const client = await readCappedFile(
    browserClientPath,
    MAX_BROWSER_CLIENT_BYTES,
  );
  if (!client) {
    return incomplete("scripts/browser-client.mjs could not be read");
  }
  const servicePath = await regularFileInside(
    root,
    join(root, "scripts", "browser-service.mjs"),
  );
  if (servicePath) {
    const service = await readCappedFile(
      servicePath,
      MAX_BROWSER_SERVICE_BYTES,
    );
    if (!service) {
      return incomplete("scripts/browser-service.mjs could not be read");
    }
    if (!exportsHandleRpc(service.toString("utf8"))) {
      return {
        kind: "unsupported",
        version,
        detail: "scripts/browser-service.mjs does not export handleRpc",
      };
    }
    return {
      kind: "ready",
      plugin: {
        root,
        version,
        browserSkillPath,
        trust: { kind: "service", servicePath },
      },
    };
  }
  if (clientNeedsTrustedService(client.toString("utf8"))) {
    return incomplete(
      "scripts/browser-client.mjs needs scripts/browser-service.mjs, which is missing",
    );
  }
  return {
    kind: "ready",
    plugin: {
      root,
      version,
      browserSkillPath,
      trust: {
        kind: "client-sha256",
        sha256: createHash("sha256").update(client).digest("hex"),
      },
    },
  };
}

/** node_repl's trusted host rejects a service module without this export. */
function exportsHandleRpc(source: string): boolean {
  return (
    /\bexport\s*\{[^}]*?\b(?:[\w$]+\s+as\s+)?handleRpc\s*[,}]/.test(source) ||
    /\bexport\s+(?:async\s+)?(?:function\s*\*?|const|let|var)\s*handleRpc\b/.test(
      source,
    )
  );
}

/** A client that reaches its service over nodeRepl.rpc cannot run on the
 * hash-pinned contract, so its missing service must fail closed. */
function clientNeedsTrustedService(source: string): boolean {
  return (
    source.includes("trusted Node REPL browser service") ||
    /\.rpc\s*!==?\s*["']function["']/.test(source)
  );
}

const CODEX_BROWSER_SKILL_MARKER = "$control-in-app-browser";

/** Detect explicit interactive website intent. A filename such as
 * browser-tab.tsx is not enough; the prompt must request a browser/page action
 * or name the Browser surface. */
export function codexPromptRequestsBrowserSkill(
  input: readonly CodexUserInput[],
): boolean {
  const text = input
    .filter(
      (item): item is Extract<CodexUserInput, { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (!text) return false;
  if (
    /\$(?:control-in-app-browser|browser(?::control-in-app-browser)?|browser-use)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:use|using|with|open|show)\s+(?:the\s+)?(?:in-app|built-in|native\s+codex\s+)?browser\b/i.test(
      text,
    ) ||
    /\bbrowser\s+use\b/i.test(text)
  ) {
    return true;
  }
  const interactive =
    /\b(?:browse|navigate|visit|explore|interact|click|scroll|open|go\s+to|walk\s+through)\b/i.test(
      text,
    );
  const webTarget =
    /https?:\/\/|(?:^|\s)(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:[\s/]|$)|\b(?:website|web\s+site|homepage|webpage|public\s+pages?|site\s+navigation)\b/i.test(
      text,
    );
  return interactive && webTarget;
}

/** Explicitly invoke the exact Browser skill returned by the verified plugin
 * root. This removes path reconstruction from the model and lets app-server
 * inject the skill directly, as recommended by its native UserInput contract. */
export function injectCodexBrowserSkillInput(
  input: readonly CodexUserInput[],
  skill: CodexNativeBrowserSkill,
): CodexUserInput[] {
  if (input.some((item) => item.type === "skill" && item.path === skill.path)) {
    return [...input];
  }
  let marked = false;
  const next = input.map((item): CodexUserInput => {
    if (marked || item.type !== "text") return item;
    marked = true;
    return {
      ...item,
      text: item.text.includes(CODEX_BROWSER_SKILL_MARKER)
        ? item.text
        : `${CODEX_BROWSER_SKILL_MARKER} ${item.text}`.trim(),
    };
  });
  return [...next, { type: "skill", name: skill.name, path: skill.path }];
}

async function childDirectoriesNewestFirst(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const directories = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map(async (entry) => {
          const path = join(root, entry.name);
          const details = await stat(path).catch(() => null);
          return details?.isDirectory()
            ? { path, modifiedAt: details.mtimeMs, name: entry.name }
            : null;
        }),
    );
    return directories
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort(
        (left, right) =>
          right.modifiedAt - left.modifiedAt ||
          right.name.localeCompare(left.name, undefined, { numeric: true }),
      )
      .map((entry) => entry.path);
  } catch {
    return [];
  }
}

async function readJsonObject(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read a file through a single handle, refusing anything over `maxBytes`.
 *
 * The size guard and the bytes we return have to describe the same inode.
 * Checking with stat() and then reading the path again leaves a window where the
 * plugin cache can swap the file, so the hash we pin into the legacy
 * NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S would cover bytes that never passed
 * the cap. Opening once and asking the handle closes it: the fstat and the read
 * both follow the descriptor, whatever the path points at afterwards.
 */
async function readCappedFile(
  path: string,
  maxBytes: number,
): Promise<Buffer | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > maxBytes) {
      return null;
    }
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function regularFile(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(path);
    return (await stat(resolved)).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

async function directory(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(path);
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function regularFileInside(root: string, path: string) {
  const file = await regularFile(path);
  return file && isInside(root, file) ? file : null;
}

async function directoryInside(root: string, path: string) {
  const child = await directory(path);
  return child && isInside(root, child) ? child : null;
}

function isInside(root: string, child: string): boolean {
  const nested = relative(root, child);
  return nested.length > 0 && !nested.startsWith("..") && !isAbsolute(nested);
}

function pushCandidate(paths: string[], value: string | undefined): void {
  const candidate = value?.trim();
  if (candidate && isAbsolute(candidate)) paths.push(candidate);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}
